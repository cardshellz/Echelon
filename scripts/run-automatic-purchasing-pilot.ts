/**
 * Controlled automatic-purchasing pilot.
 *
 * Readiness discovery is read-only and ranks actionable candidates:
 *   npm run procurement:automatic-purchasing-pilot -- --list --limit=25
 *
 * Preflight is the default and performs no lifecycle or PO writes:
 *   npm run procurement:automatic-purchasing-pilot -- --sku=EXAMPLE-SKU
 *
 * Execution is intentionally explicit and requires an attributable operator:
 *   npm run procurement:automatic-purchasing-pilot -- --sku=EXAMPLE-SKU --execute --actor=USER-ID
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

interface CliOptions {
  sku: string | null;
  list: boolean;
  limit: number;
  execute: boolean;
  actor: string | null;
}

export function parseAutomaticPurchasingPilotArgs(args: string[]): CliOptions {
  let sku: string | null = null;
  let list = false;
  let limit = 25;
  let limitProvided = false;
  let execute = false;
  let actor: string | null = null;

  for (const arg of args) {
    if (arg === "--execute") {
      execute = true;
    } else if (arg === "--list") {
      list = true;
    } else if (arg.startsWith("--limit=")) {
      const rawLimit = arg.slice("--limit=".length).trim();
      if (!/^\d+$/.test(rawLimit)) throw new Error("--limit must be an integer between 1 and 100");
      limit = Number(rawLimit);
      limitProvided = true;
    } else if (arg.startsWith("--sku=")) {
      sku = arg.slice("--sku=".length).trim() || null;
    } else if (arg.startsWith("--actor=")) {
      actor = arg.slice("--actor=".length).trim() || null;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("--limit must be an integer between 1 and 100");
  }
  if (list && sku) throw new Error("--list cannot be combined with --sku");
  if (list && execute) throw new Error("--list cannot be combined with --execute");
  if (list && actor) throw new Error("--list cannot be combined with --actor");
  if (!list && limitProvided) throw new Error("--limit requires --list");
  if (!list && !sku) throw new Error("--sku is required unless --list is used");
  if (sku && sku.length > 100) throw new Error("--sku must be 100 characters or fewer");
  if (execute && !actor) throw new Error("--actor is required with --execute");
  if (actor && actor.length > 100) throw new Error("--actor must be 100 characters or fewer");
  return { sku, list, limit, execute, actor };
}

export async function loadLocalEnvironmentIfNeeded(): Promise<void> {
  if (process.env.DATABASE_URL) return;
  try {
    const dotenv = await import("dotenv");
    dotenv.config({ quiet: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
}

async function main(): Promise<void> {
  const options = parseAutomaticPurchasingPilotArgs(process.argv.slice(2));
  await loadLocalEnvironmentIfNeeded();
  const { pool } = await import("../server/db");

  try {
    const {
      previewAutomaticPurchasingPilot,
      reportAutomaticPurchasingReadiness,
      runAutoDraftJob,
    } = await import("../server/jobs/auto-draft.job");

    if (options.list) {
      const report = await reportAutomaticPurchasingReadiness({ limit: options.limit });
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    if (!options.execute) {
      const preview = await previewAutomaticPurchasingPilot({ sku: options.sku! });
      console.log(JSON.stringify(preview, null, 2));
      if (!preview.eligible) process.exitCode = 2;
      return;
    }

    const operator = await pool.query(
      "SELECT id FROM public.users WHERE id = $1 LIMIT 1",
      [options.actor],
    );
    if (operator.rowCount !== 1) {
      throw new Error("--actor must identify an existing application user");
    }

    const result = await runAutoDraftJob({
      triggeredBy: "manual",
      triggeredByUser: options.actor!,
      pilot: { sku: options.sku! },
    });
    console.log(JSON.stringify({
      mode: "execute",
      operator: options.actor,
      runId: result.recommendationRun.id,
      purchaseOrders: result.pos,
      itemsDrafted: result.itemsDrafted,
      itemsSkippedAfterAnalysis: result.itemsSkippedAfterAnalysis,
      pilot: result.pilot,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false;

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
