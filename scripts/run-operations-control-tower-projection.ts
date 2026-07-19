import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import { runControlTowerProjectionJob } from "../server/modules/operations/control-tower-v2.job";
import {
  CONTROL_TOWER_SOURCE_ADAPTERS,
  getControlTowerSourceAdapter,
} from "../server/modules/operations/control-tower-v2.sources";

interface ProjectionFlags {
  help: boolean;
  execute: boolean;
  json: boolean;
  sourceNames: string[];
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/run-operations-control-tower-projection.ts --dry-run --source=all",
    "  npx tsx scripts/run-operations-control-tower-projection.ts --execute --source=all",
    "  npx tsx scripts/run-operations-control-tower-projection.ts --execute --source=inventory_integrity,channel_fulfillment",
    "",
    "Flags:",
    "  --dry-run       Read and validate source rows without writing. Default.",
    "  --execute       Persist source runs, work items, and observations.",
    "  --source=VALUE  all or a comma-separated source list.",
    "  --json          Print the final summary as JSON only.",
    "",
    `Sources: ${CONTROL_TOWER_SOURCE_ADAPTERS.map((adapter) => adapter.name).join(", ")}`,
  ].join("\n");
}

export function parseProjectionFlags(argv: string[]): ProjectionFlags {
  const allowedBare = new Set(["--help", "-h", "--dry-run", "--execute", "--json"]);
  for (const arg of argv) {
    if (allowedBare.has(arg) || arg.startsWith("--source=")) continue;
    throw new Error(`Unknown flag: ${arg}`);
  }
  if (argv.includes("--dry-run") && argv.includes("--execute")) {
    throw new Error("Choose either --dry-run or --execute, not both");
  }
  const sourceArg = argv.find((arg) => arg.startsWith("--source="));
  const sourceValue = sourceArg?.slice("--source=".length).trim() || "all";
  const sourceNames = sourceValue === "all"
    ? CONTROL_TOWER_SOURCE_ADAPTERS.map((adapter) => adapter.name)
    : [...new Set(sourceValue.split(",").map((value) => value.trim()).filter(Boolean))];
  if (sourceNames.length === 0) throw new Error("--source must include at least one source");
  for (const sourceName of sourceNames) {
    if (!getControlTowerSourceAdapter(sourceName)) throw new Error(`Unknown source: ${sourceName}`);
  }
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    execute: argv.includes("--execute"),
    json: argv.includes("--json"),
    sourceNames,
  };
}

function connectionString(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required");
  return value;
}

export async function main(): Promise<void> {
  const flags = parseProjectionFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const databaseUrl = connectionString();
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") ? undefined : { rejectUnauthorized: false },
    max: 1,
    application_name: "operations-control-tower-projector",
  });
  const client = await pool.connect();
  try {
    const selected = flags.sourceNames.map((name) => getControlTowerSourceAdapter(name)!);
    const result = await runControlTowerProjectionJob({
      client,
      execute: flags.execute,
      adapters: selected,
    });
    if (flags.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`[Operations Control Tower projection] mode=${result.mode} sources=${selected.length}`);
      for (const source of result.sources) {
        console.log(`[Operations Control Tower projection] ${source.sourceName} ${JSON.stringify(source)}`);
      }
      console.log(`[Operations Control Tower projection] complete ${JSON.stringify({
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        failedSources: result.failedSources,
      })}`);
    }
    if (result.failedSources > 0) process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(`[Operations Control Tower projection] fatal: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
