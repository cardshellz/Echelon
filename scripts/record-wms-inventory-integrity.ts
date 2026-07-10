/**
 * Records a complete read-only WMS integrity snapshot in the durable lifecycle
 * registry. The inventory audit itself remains a REPEATABLE READ, READ ONLY
 * transaction. A separate transaction writes only inventory.integrity_* audit
 * tables.
 *
 * Usage:
 *   npx tsx scripts/record-wms-inventory-integrity.ts --dry-run
 *   npx tsx scripts/record-wms-inventory-integrity.ts --execute
 *   npx tsx scripts/record-wms-inventory-integrity.ts --execute --check=terminal_order_open_reservation
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  buildObservedIntegrityFindings,
  connectionStringFromEnv,
  parseFlags as parseAuditFlags,
  runWmsInventoryAudit,
} from "./audit-wms-inventory-integrity";
import {
  persistIntegrityAuditRegistry,
  previewIntegrityAuditRegistry,
  type IntegrityAuditRegistryInput,
  type IntegrityLifecycleSummary,
} from "../server/modules/inventory/integrity/integrity-registry.repository";

interface RecorderFlags {
  help: boolean;
  execute: boolean;
  json: boolean;
  checkId: string | null;
  statementTimeoutMs: number;
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/record-wms-inventory-integrity.ts --dry-run",
    "  npx tsx scripts/record-wms-inventory-integrity.ts --execute",
    "",
    "Flags:",
    "  --dry-run                  Preview lifecycle changes. Default.",
    "  --execute                  Persist one complete audit run.",
    "  --check=ID                 Restrict the run to one check.",
    "  --statement-timeout-ms=N   Per-query timeout. Default 120000.",
    "  --json                     Print machine-readable JSON.",
    "  --help                     Print this help.",
    "",
    "Safety:",
    "  Inventory queries run in one REPEATABLE READ, READ ONLY transaction.",
    "  Execute mode writes only inventory.integrity_* audit registry tables.",
    "  Finding persistence is serialized and atomic; no inventory quantity is mutated.",
  ].join("\n");
}

export function parseRecorderFlags(argv: string[]): RecorderFlags {
  const allowedBare = new Set(["--help", "-h", "--dry-run", "--execute", "--json"]);
  for (const arg of argv) {
    if (allowedBare.has(arg)) continue;
    if (arg.startsWith("--check=")) continue;
    if (arg.startsWith("--statement-timeout-ms=")) continue;
    throw new Error(`Unknown flag: ${arg}`);
  }
  if (argv.includes("--dry-run") && argv.includes("--execute")) {
    throw new Error("Choose either --dry-run or --execute, not both");
  }

  const checkArg = argv.find((arg) => arg.startsWith("--check="));
  const checkId = checkArg?.slice("--check=".length).trim() ?? null;
  if (checkId !== null && checkId.length === 0) throw new Error("--check cannot be blank");

  const timeoutArg = argv.find((arg) => arg.startsWith("--statement-timeout-ms="));
  const statementTimeoutMs = timeoutArg == null
    ? 120_000
    : Number(timeoutArg.slice("--statement-timeout-ms=".length).trim());
  if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs < 1_000 || statementTimeoutMs > 900_000) {
    throw new Error("--statement-timeout-ms must be an integer between 1000 and 900000");
  }

  return {
    help: argv.includes("--help") || argv.includes("-h"),
    execute: argv.includes("--execute"),
    json: argv.includes("--json"),
    checkId,
    statementTimeoutMs,
  };
}

function sourceVersion(): string | null {
  return process.env.HEROKU_SLUG_COMMIT
    ?? process.env.SOURCE_VERSION
    ?? process.env.GIT_COMMIT
    ?? null;
}

export function buildRegistryInput(params: {
  runId: string;
  scope: "all" | "targeted";
  startedAt: string;
  completedAt: string;
  audit: Awaited<ReturnType<typeof runWmsInventoryAudit>>;
}): IntegrityAuditRegistryInput {
  return {
    runId: params.runId,
    scope: params.scope,
    sourceVersion: sourceVersion(),
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

function printResult(params: {
  mode: "dry-run" | "execute";
  input: IntegrityAuditRegistryInput;
  lifecycle: IntegrityLifecycleSummary;
  json: boolean;
}): void {
  const output = {
    mode: params.mode,
    runId: params.input.runId,
    snapshotAt: params.input.snapshotAt,
    checks: params.input.checks.length,
    blockers: params.input.blockerCount,
    warnings: params.input.warningCount,
    lifecycle: params.lifecycle,
  };
  if (params.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  console.log(
    `[WMS inventory integrity registry] mode=${output.mode} runId=${output.runId} `
      + `snapshot=${output.snapshotAt} checks=${output.checks} `
      + `blockers=${output.blockers} warnings=${output.warnings}`,
  );
  console.log(JSON.stringify(output.lifecycle));
}

export async function main(): Promise<void> {
  const flags = parseRecorderFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const auditArgs = ["--limit=all", `--statement-timeout-ms=${flags.statementTimeoutMs}`];
  if (flags.checkId !== null) auditArgs.push(`--check=${flags.checkId}`);
  const auditFlags = parseAuditFlags(auditArgs);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const audit = await runWmsInventoryAudit(auditFlags);
  const completedAt = new Date().toISOString();
  const input = buildRegistryInput({
    runId,
    scope: flags.checkId === null ? "all" : "targeted",
    startedAt,
    completedAt,
    audit,
  });

  const connectionString = connectionStringFromEnv();
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: false },
    max: 1,
    application_name: "wms-inventory-integrity-registry",
  });
  const client = await pool.connect();
  try {
    const lifecycle = flags.execute
      ? await persistIntegrityAuditRegistry(client, input)
      : await previewIntegrityAuditRegistry(client, input);
    printResult({ mode: flags.execute ? "execute" : "dry-run", input, lifecycle, json: flags.json });
  } finally {
    client.release();
    await pool.end();
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(`[WMS inventory integrity registry] fatal: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
