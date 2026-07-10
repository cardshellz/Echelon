import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  activateIntegrityMonitoring,
  previewIntegrityMonitoringActivation,
} from "../server/modules/inventory/integrity/integrity-monitor.repository";
import { connectionStringFromEnv } from "./audit-wms-inventory-integrity";

interface ActivationFlags {
  help: boolean;
  execute: boolean;
  baselineRunId: string | null;
  actor: string | null;
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/activate-wms-inventory-integrity-monitor.ts --dry-run --baseline-run-id=UUID",
    "  npx tsx scripts/activate-wms-inventory-integrity-monitor.ts --execute --baseline-run-id=UUID --actor=IDENTITY",
    "",
    "The command is idempotent for the same baseline. It refuses to replace an existing watermark.",
  ].join("\n");
}

export function parseActivationFlags(argv: string[]): ActivationFlags {
  const allowedBare = new Set(["--help", "-h", "--dry-run", "--execute"]);
  for (const arg of argv) {
    if (allowedBare.has(arg)) continue;
    if (arg.startsWith("--baseline-run-id=")) continue;
    if (arg.startsWith("--actor=")) continue;
    throw new Error(`Unknown flag: ${arg}`);
  }
  if (argv.includes("--dry-run") && argv.includes("--execute")) {
    throw new Error("Choose either --dry-run or --execute, not both");
  }
  const baselineRunId = argv.find((arg) => arg.startsWith("--baseline-run-id="))
    ?.slice("--baseline-run-id=".length).trim() ?? null;
  const actor = argv.find((arg) => arg.startsWith("--actor="))
    ?.slice("--actor=".length).trim() ?? null;
  if (
    baselineRunId !== null
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      baselineRunId,
    )
  ) {
    throw new Error("--baseline-run-id must be a UUID");
  }
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    execute: argv.includes("--execute"),
    baselineRunId,
    actor,
  };
}

export async function main(): Promise<void> {
  const flags = parseActivationFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }
  if (!flags.baselineRunId) throw new Error("--baseline-run-id is required");
  if (flags.execute && !flags.actor) throw new Error("--actor is required with --execute");

  const connectionString = process.env.WMS_INTEGRITY_REGISTRY_DATABASE_URL || connectionStringFromEnv();
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: false },
    max: 1,
    application_name: "wms-integrity-monitor-activation",
  });
  const client = await pool.connect();
  try {
    const result = flags.execute
      ? await activateIntegrityMonitoring(client, {
        baselineRunId: flags.baselineRunId,
        actor: flags.actor!,
        now: new Date(),
      })
      : await previewIntegrityMonitoringActivation(client, flags.baselineRunId);
    console.log(JSON.stringify({ mode: flags.execute ? "execute" : "dry-run", ...result }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(`[WMS inventory integrity activation] fatal: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
