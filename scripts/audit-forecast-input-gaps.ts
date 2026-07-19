/**
 * Dry-run forecast input gap audit.
 *
 * Usage:
 *   npx tsx scripts/audit-forecast-input-gaps.ts --json
 *   npx tsx scripts/audit-forecast-input-gaps.ts --json --limit=25
 *   npx tsx scripts/audit-forecast-input-gaps.ts --json --lookbackDays=60
 *
 * This script is intentionally read-only. It reuses the purchasing
 * recommendation engine and forecast gap diagnostics so operators can decide
 * whether remaining forecast issues are source-data repair candidates or
 * ordinary demand-review work before adding any backfill mutation.
 */

import fs from "node:fs";
import path from "node:path";

type CliOptions = {
  json: boolean;
  limit: number;
  lookbackDays: number | null;
};

function parsePositiveIntValue(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseBooleanValue(rawValue: string | undefined, label: string): boolean | null {
  if (rawValue === undefined) return null;
  const raw = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${label} must be true or false`);
}

function firstEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function applyNpmConfigDefaults(options: CliOptions): void {
  const json = parseBooleanValue(firstEnv("npm_config_json"), "--json");
  if (json !== null) options.json = json;

  const limit = firstEnv("npm_config_limit");
  if (limit !== undefined) options.limit = Math.min(parsePositiveIntValue(Number(limit), "--limit"), 100);

  const lookbackDays = firstEnv("npm_config_lookbackdays", "npm_config_lookback_days");
  if (lookbackDays !== undefined) {
    options.lookbackDays = parsePositiveIntValue(Number(lookbackDays), "--lookbackDays");
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    limit: 25,
    lookbackDays: null,
  };

  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("--limit=")) {
      options.limit = Math.min(parsePositiveIntValue(Number(arg.slice("--limit=".length)), "--limit"), 100);
    } else if (arg.startsWith("--lookbackDays=")) {
      options.lookbackDays = parsePositiveIntValue(Number(arg.slice("--lookbackDays=".length)), "--lookbackDays");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  applyNpmConfigDefaults(options);
  return options;
}

async function loadDotenvIfAvailable(): Promise<void> {
  try {
    const dotenv = await import("dotenv");
    dotenv.config({ quiet: true });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("dotenv")) {
      throw error;
    }
  }

  if (process.env.DATABASE_URL) return;

  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const env = fs.readFileSync(envPath, "utf8").replace(/\0/g, "");
  for (const key of ["DATABASE_URL"]) {
    const line = env.split(/\r?\n/).find((entry) => entry.startsWith(`${key}=`));
    if (!line) continue;
    let value = line.slice(key.length + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    break;
  }
}

function summarizeDecision(actionCounts: Record<string, number>) {
  const sourceRepairCount =
    (actionCounts.repair_order_velocity_source ?? 0) +
    (actionCounts.rebuild_forecast_windows ?? 0);
  const demandReviewCount =
    (actionCounts.verify_recent_demand ?? 0) +
    (actionCounts.monitor_thin_sample ?? 0);

  let recommendedNextAction = "none";
  if (sourceRepairCount > 0) {
    recommendedNextAction = "investigate_source_repair_before_backfill";
  } else if (demandReviewCount > 0) {
    recommendedNextAction = "work_forecast_review_queue";
  }

  return {
    sourceRepairCount,
    demandReviewCount,
    requiresBackfillInvestigation: sourceRepairCount > 0,
    recommendedNextAction,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotenvIfAvailable();

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const { pool } = await import("../server/db");
  const { procurementStorage } = await import("../server/modules/procurement");
  const { inventoryStorage } = await import("../server/modules/inventory");
  const { loadPurchasingRecommendationContext } = await import(
    "../server/modules/procurement/purchasing-recommendation-context.service"
  );
  const { generatePurchasingRecommendations } = await import(
    "../server/modules/procurement/purchasing-recommendation.engine"
  );
  const { buildForecastInputGapDiagnostics } = await import(
    "../server/modules/procurement/forecast-input-gap-diagnostics.service"
  );

  const storage = { ...procurementStorage, ...inventoryStorage };

  try {
    const configuredLookback = options.lookbackDays ?? await storage.getVelocityLookbackDays();
    const rawRows = await storage.getReorderAnalysisData(configuredLookback);
    const settings = await storage.getAutoDraftSettings();
    const context = await loadPurchasingRecommendationContext();
    const recommendationResult = generatePurchasingRecommendations({
      rows: rawRows as any[],
      lookbackDays: configuredLookback,
      autoDraftSettings: settings,
      requireVendor: Boolean(settings.skipNoVendor),
      ...context,
    });
    const diagnostics = buildForecastInputGapDiagnostics(recommendationResult, { limit: options.limit });
    const output = {
      mode: "dry-run",
      generatedAt: new Date().toISOString(),
      lookbackDays: configuredLookback,
      autoDraftMode: settings.autoDraftMode ?? "draft_po",
      approvalPolicy: settings.approvalPolicy ?? "high_confidence_only",
      ...diagnostics,
      decision: summarizeDecision(diagnostics.actionCounts),
    };

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(
        `Forecast input gaps: ${output.totalIssueItems}/${output.totalRecommendations} recommendations affected.`,
      );
      console.log(
        `Source repair candidates: ${output.decision.sourceRepairCount}; demand-review items: ${output.decision.demandReviewCount}.`,
      );
      console.log(`Recommended next action: ${output.decision.recommendedNextAction}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
