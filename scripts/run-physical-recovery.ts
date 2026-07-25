/**
 * Operator entrypoint for the ShipStation physical-recovery sweep.
 *
 * The scheduled sweep (fulfillment-sweeper.scheduler.ts) runs this same
 * service with fixed bounds: limit 10, minAge 15m, maxAge 30 DAYS, every
 * 10 minutes, oldest first. This script runs the identical mechanism with
 * operator-chosen bounds — most importantly per-order targeting and no age
 * cap — and prints the per-candidate outcome (planned / recovered /
 * no_match / client_not_configured / error) that the scheduler only logs
 * in aggregate.
 *
 * DRY-RUN by default (reads + ShipStation lookups, no writes).
 *
 *   npx tsx scripts/run-physical-recovery.ts --order='#59896'      # one order, dry-run
 *   npx tsx scripts/run-physical-recovery.ts --order='#59896' --execute
 *   npx tsx scripts/run-physical-recovery.ts --limit=200           # whole backlog, dry-run
 *   npx tsx scripts/run-physical-recovery.ts --limit=200 --execute
 *
 * Env: EXTERNAL_DATABASE_URL (or DATABASE_URL) + SHIPSTATION_V2_API_KEY.
 * Pull both from Heroku config when running locally.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";

export interface CliOptions {
  orderNumber: string | null;
  execute: boolean;
  limit: number;
  maxAgeDays: number | null;
  minAgeMinutes: number;
}

export function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = {
    orderNumber: null,
    execute: false,
    limit: 50,
    maxAgeDays: null, // operator default: NO age cap (the scheduler's 30d cap is its own)
    minAgeMinutes: 15,
  };
  for (const arg of argv) {
    if (arg === "--execute") opts.execute = true;
    else if (arg.startsWith("--order=")) opts.orderNumber = arg.slice("--order=".length).trim() || null;
    else if (arg.startsWith("--limit=")) opts.limit = Math.min(500, Math.max(1, Number(arg.split("=")[1]) || 50));
    else if (arg.startsWith("--max-age-days=")) opts.maxAgeDays = Number(arg.split("=")[1]) || null;
    else if (arg.startsWith("--min-age-minutes=")) opts.minAgeMinutes = Math.max(0, Number(arg.split("=")[1]) || 15);
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

/** WMS stores Shopify order numbers WITH the leading '#'. Try both forms. */
export function orderNumberCandidates(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("#")) return [trimmed, trimmed.slice(1)];
  return [`#${trimmed}`, trimmed];
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("Set EXTERNAL_DATABASE_URL (or DATABASE_URL).");
    process.exit(1);
  }
  if (!(process.env.SHIPSTATION_V2_API_KEY ?? "").trim()) {
    console.error("SHIPSTATION_V2_API_KEY is not set — the recovery client cannot call ShipStation.");
    process.exit(1);
  }

  // rejectUnauthorized:false is the repo-wide script convention (P4.5 tracks proper CA verification)
  const pool = new Pool({ connectionString, max: 4, ssl: { rejectUnauthorized: false } });
  const db = drizzle(pool) as any;

  // Full service graph — identical wiring to production boot. Schedulers are
  // NOT started here (index.ts owns those), so this constructs and exits.
  const { createServices } = await import("../server/services/index");
  const services: any = createServices(db);
  const recovery = services.shipStationPhysicalRecovery;
  if (!recovery?.recover) {
    console.error("shipStationPhysicalRecovery service not available from createServices()");
    process.exit(1);
  }

  const mode = opts.execute ? "execute" : "dry-run";
  const targets = opts.orderNumber ? orderNumberCandidates(opts.orderNumber) : [null];

  let anyCandidates = 0;
  for (const orderNumber of targets) {
    const result = await recovery.recover({
      mode,
      orderNumber,
      limit: opts.limit,
      maxAgeDays: opts.maxAgeDays,
      minAgeMinutes: opts.minAgeMinutes,
    });
    anyCandidates += result.candidates;

    console.log(
      `\n=== ${mode.toUpperCase()} ${orderNumber ? `order ${orderNumber}` : `backlog (limit ${opts.limit})`} ===`,
    );
    console.log(
      `candidates=${result.candidates} matchedPackages=${result.matchedPackages} ` +
        `labelsObserved=${result.labelsObserved} labelsInserted=${result.labelsInserted} ` +
        `labelLinks=${result.labelLinksInserted} trackingHydrated=${result.trackingSnapshotsHydrated} ` +
        `dispatchCommands=${result.dispatchCommandsCreated} noMatch=${result.noMatch} errors=${result.errors}`,
    );
    for (const r of result.results ?? []) {
      console.log(
        `  ${r.candidate.orderNumber} (wms=${r.candidate.wmsOrderId}, oms=${r.candidate.omsOrderId}, ` +
          `${r.candidate.provider}) shipments=[${r.candidate.wmsShipmentIds}] -> ${r.outcome}` +
          (r.error ? ` | error: ${r.error}` : "") +
          (r.trackingWarnings?.length ? ` | warnings: ${r.trackingWarnings.join("; ")}` : ""),
      );
      for (const pkg of r.matchedPackages ?? []) {
        console.log(`      matched package: ${JSON.stringify(pkg).slice(0, 300)}`);
      }
    }
    // A per-order run that matched on the first form doesn't need the second.
    if (orderNumber && result.candidates > 0) break;
  }

  if (opts.orderNumber && anyCandidates === 0) {
    console.log(
      "\nNo candidates found for that order — it does not pass the eligibility gates " +
        "(held/covered/fulfilled/cancelled) or the order number does not match wms.orders.order_number.",
    );
  }
  if (!opts.execute) {
    console.log("\nDry-run complete. Re-run with --execute to record labels + tracking and push to the channel.");
  }
  await pool.end();
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
