import type {
  DropshipDogfoodLaunchStatusResult,
  DropshipDogfoodReadinessStatus,
} from "../server/modules/dropship/application/dropship-ops-surface-service";

interface CliOptions {
  platform?: "ebay" | "shopify";
  search?: string;
  staleAfterHours?: number;
  json: boolean;
  failOnWarning: boolean;
  help: boolean;
}

const STATUS_EXIT_CODES: Record<DropshipDogfoodReadinessStatus, number> = {
  ready: 0,
  warning: 0,
  blocked: 2,
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  await loadDotenvIfAvailable();

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to load dropship dogfood launch status.");
  }

  const { createDropshipOpsSurfaceServiceFromEnv } = await import(
    "../server/modules/dropship/infrastructure/dropship-ops-surface.factory"
  );
  const { pool } = await import("../server/db");

  try {
    const service = createDropshipOpsSurfaceServiceFromEnv();
    const result = await service.getDogfoodLaunchStatus({
      platform: options.platform,
      search: options.search,
      staleAfterHours: options.staleAfterHours,
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHumanResult(result);
    }

    const exitCode = options.failOnWarning && result.status === "warning"
      ? 1
      : STATUS_EXIT_CODES[result.status];
    process.exitCode = exitCode;
  } finally {
    try {
      await pool.end();
    } catch (error) {
      console.error(`Failed to close database pool: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function loadDotenvIfAvailable(): Promise<void> {
  try {
    const dotenv = await import("dotenv");
    dotenv.config({ quiet: true });
  } catch (error) {
    if (isMissingOptionalDotenv(error)) {
      return;
    }
    throw error;
  }
}

function isMissingOptionalDotenv(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "ERR_MODULE_NOT_FOUND"
    && error.message.includes("dotenv");
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    failOnWarning: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--fail-on-warning":
        options.failOnWarning = true;
        break;
      case "--platform":
        options.platform = parsePlatform(readRequiredValue(args, index, arg));
        index += 1;
        break;
      case "--search":
        options.search = readRequiredValue(args, index, arg).trim();
        index += 1;
        break;
      case "--stale-after-hours":
        options.staleAfterHours = parsePositiveInteger(readRequiredValue(args, index, arg), arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function readRequiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePlatform(value: string): "ebay" | "shopify" {
  if (value === "ebay" || value === "shopify") {
    return value;
  }
  throw new Error("--platform must be ebay or shopify.");
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function printHumanResult(result: DropshipDogfoodLaunchStatusResult): void {
  console.log("=== Dropship Dogfood Launch Status ===");
  console.log(`Status: ${result.status.toUpperCase()}`);
  console.log(`Generated: ${result.generatedAt.toISOString()}`);
  console.log(`Message: ${result.message}`);
  console.log("");

  console.log("Launch gate:");
  console.log(`  Ready vendor/store rows: ${result.launchGate.readyVendorStoreCount}`);
  console.log(`  Warning vendor/store rows: ${result.launchGate.warningVendorStoreCount}`);
  console.log(`  Blocked vendor/store rows: ${result.launchGate.blockedVendorStoreCount}`);
  console.log(`  System blockers: ${result.launchGate.systemBlockedCount}`);
  console.log(`  System warnings: ${result.launchGate.systemWarningCount}`);
  console.log(`  Blockers: ${result.launchGate.blockerCount}`);
  console.log(`  Warnings: ${result.launchGate.warningCount}`);
  console.log("");

  printSystemChecks(result);
  printFirstBlockers(result);
  printRunbook(result);
  printLaunchCandidates(result);
  printSmokeEvidence(result);
}

function printSystemChecks(result: DropshipDogfoodLaunchStatusResult): void {
  const checks = result.readiness.systemChecks.filter((check) => check.status !== "ready");
  if (checks.length === 0) {
    console.log("System checks: ready");
    console.log("");
    return;
  }

  console.log("System checks needing attention:");
  checks.forEach((check) => {
    console.log(`  [${check.status}] ${check.label}: ${check.message}`);
    if (check.requiredEnv.length > 0) {
      console.log(`    Required: ${check.requiredEnv.join(", ")}`);
    }
  });
  console.log("");
}

function printFirstBlockers(result: DropshipDogfoodLaunchStatusResult): void {
  if (result.launchGate.firstBlockers.length === 0) {
    return;
  }

  console.log("First blockers:");
  result.launchGate.firstBlockers.forEach((blocker) => {
    const scope = blocker.scope === "system"
      ? "system"
      : `vendor ${blocker.vendorId ?? "unknown"}, store ${blocker.storeConnectionId ?? "none"}`;
    console.log(`  ${scope}: ${blocker.label} - ${blocker.message}`);
  });
  console.log("");
}

function printRunbook(result: DropshipDogfoodLaunchStatusResult): void {
  console.log("Runbook:");
  result.runbookSteps.forEach((step, index) => {
    console.log(`  ${index + 1}. [${step.status}] ${step.label}`);
    console.log(`     ${step.message}`);
    console.log(`     Action: ${step.action}`);
    step.evidence.slice(0, 3).forEach((evidence) => {
      console.log(`     Evidence: ${evidence}`);
    });
  });
  console.log("");
}

function printLaunchCandidates(result: DropshipDogfoodLaunchStatusResult): void {
  if (result.launchCandidates.length === 0) {
    console.log("Launch candidates: none");
    console.log("");
    return;
  }

  console.log("Launch candidates:");
  result.launchCandidates.slice(0, 10).forEach((candidate) => {
    console.log(
      `  vendor ${candidate.vendor.vendorId}, ${candidate.storeConnection.platform} store ${candidate.storeConnection.storeConnectionId}: readiness ${candidate.readinessStatus}, smoke ${candidate.smokeStatus}`,
    );
    console.log(`    Last smoke activity: ${candidate.lastSmokeActivityAt?.toISOString() ?? "missing"}`);
  });
  console.log("");
}

function printSmokeEvidence(result: DropshipDogfoodLaunchStatusResult): void {
  console.log("Smoke evidence:");
  console.log(`  ${result.smoke.message}`);
  console.log(`  Ready: ${result.smoke.readyCandidateCount}`);
  console.log(`  Warning: ${result.smoke.warningCandidateCount}`);
  console.log(`  Blocked: ${result.smoke.blockedCandidateCount}`);
  result.smoke.candidates.slice(0, 5).forEach((candidate) => {
    console.log(
      `  vendor ${candidate.vendor.vendorId}, ${candidate.storeConnection.platform} store ${candidate.storeConnection.storeConnectionId}: ${candidate.status}`,
    );
    candidate.stages.forEach((stage) => {
      console.log(`    [${stage.status}] ${stage.label}: ${stage.message}`);
    });
  });
}

function printHelp(): void {
  console.log(`Dropship dogfood launch status

Usage:
  npx tsx scripts/dropship-dogfood-status.ts [options]

Options:
  --platform ebay|shopify        Scope readiness and smoke evidence to one platform.
  --search <text>                Scope readiness and smoke evidence by vendor/store text.
  --stale-after-hours <hours>    Override smoke freshness window for this run.
  --json                         Print the raw launch status JSON.
  --fail-on-warning              Exit 1 when status is warning. Blocked always exits 2.
  --help                         Show this help.

Exit codes:
  0  ready or warning
  1  warning with --fail-on-warning, or runtime error
  2  blocked
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
