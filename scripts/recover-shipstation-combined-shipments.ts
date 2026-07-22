/**
 * Discover completed ShipStation packages that were combined under a sibling
 * order and replay them through Echelon's canonical SHIP_NOTIFY path.
 *
 * The script never writes fulfillment or inventory directly. Execute mode
 * enqueues an idempotent SHIP_NOTIFY retry only after an exact wms-item-* key
 * in the provider shipment proves that the package belongs to the WMS order.
 */

import { fileURLToPath } from "node:url";
import { db } from "../server/db";
import { createShipStationPhysicalRecoveryService } from "../server/modules/oms/shipstation-physical-recovery.service";
import { createShipStationPhysicalRecoveryClient } from "../server/modules/shipping/shipstation-physical-recovery.client";

interface Flags {
  mode: "dry-run" | "execute";
  limit: number | null;
  orderNumber: string | null;
  minAgeHours: number;
  maxAgeDays: number | null;
  requestTimeoutMs: number;
  minimumRequestIntervalMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  help: boolean;
}

function parsePositiveInteger(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function readFlag(argv: string[], name: string): string | null {
  const prefix = `--${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : null;
}

export function parseFlags(argv: string[]): Flags {
  const execute = argv.includes("--execute");
  const dryRun = argv.includes("--dry-run");
  if (execute && dryRun) throw new Error("Cannot pass both --execute and --dry-run");
  const known = new Set(["--execute", "--dry-run", "--help", "-h"]);
  const prefixes = [
    "--limit=",
    "--order-number=",
    "--min-age-hours=",
    "--max-age-days=",
    "--request-timeout-ms=",
    "--delay-ms=",
    "--max-retries=",
    "--retry-base-delay-ms=",
  ];
  const unknown = argv.find((arg) => !known.has(arg) && !prefixes.some((prefix) => arg.startsWith(prefix)));
  if (unknown) throw new Error(`Unknown flag: ${unknown}`);

  const limitRaw = readFlag(argv, "limit") ?? "25";
  const limit = limitRaw.toLowerCase() === "all"
    ? null
    : parsePositiveInteger(limitRaw, "--limit");
  const maxAgeRaw = readFlag(argv, "max-age-days") ?? "all";
  const maxAgeDays = maxAgeRaw.toLowerCase() === "all"
    ? null
    : parsePositiveInteger(maxAgeRaw, "--max-age-days");
  const orderNumber = readFlag(argv, "order-number");
  if (orderNumber !== null && (!orderNumber || orderNumber.length > 50)) {
    throw new Error("--order-number must contain 1 through 50 characters");
  }

  return {
    mode: execute ? "execute" : "dry-run",
    limit,
    orderNumber,
    minAgeHours: parsePositiveInteger(readFlag(argv, "min-age-hours") ?? "6", "--min-age-hours"),
    maxAgeDays,
    requestTimeoutMs: parsePositiveInteger(
      readFlag(argv, "request-timeout-ms") ?? "20000",
      "--request-timeout-ms",
    ),
    minimumRequestIntervalMs: parseNonNegativeInteger(
      readFlag(argv, "delay-ms") ?? "500",
      "--delay-ms",
    ),
    maxRetries: parseNonNegativeInteger(
      readFlag(argv, "max-retries") ?? "2",
      "--max-retries",
    ),
    retryBaseDelayMs: parseNonNegativeInteger(
      readFlag(argv, "retry-base-delay-ms") ?? "2000",
      "--retry-base-delay-ms",
    ),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/recover-shipstation-combined-shipments.ts --dry-run --limit=25",
    "  npx tsx scripts/recover-shipstation-combined-shipments.ts --execute --order-number=#59564",
    "  npx tsx scripts/recover-shipstation-combined-shipments.ts --execute --limit=all --max-age-days=all",
    "",
    "Flags:",
    "  --dry-run                 Discover and print only. Default.",
    "  --execute                 Enqueue canonical SHIP_NOTIFY retries.",
    "  --limit=N|all             Candidate order limit. Default 25.",
    "  --order-number=TEXT       Restrict to one channel order number.",
    "  --min-age-hours=N         Ignore recent active shipments. Default 6.",
    "  --max-age-days=N|all      Historical lookback. Default all.",
    "  --request-timeout-ms=N    Per-request timeout. Default 20000.",
    "  --delay-ms=N              Minimum API request interval. Default 500.",
    "  --max-retries=N           Retry count for transient API errors. Default 2.",
    "  --retry-base-delay-ms=N   Deterministic retry base delay. Default 2000.",
  ].join("\n");
}

export async function run(flags: Flags): Promise<void> {
  if (flags.help) {
    console.log(usage());
    return;
  }

  const service = createShipStationPhysicalRecoveryService(db, {
    client: createShipStationPhysicalRecoveryClient({
      requestTimeoutMs: flags.requestTimeoutMs,
      minimumRequestIntervalMs: flags.minimumRequestIntervalMs,
      maxRetries: flags.maxRetries,
      retryBaseDelayMs: flags.retryBaseDelayMs,
    }),
  });
  const result = await service.recover({
    mode: flags.mode,
    limit: flags.limit,
    minAgeHours: flags.minAgeHours,
    maxAgeDays: flags.maxAgeDays,
    orderNumber: flags.orderNumber,
  });

  console.log(
    `[ShipStation combined shipment recovery] mode=${flags.mode} candidates=${result.candidates}`,
  );
  for (const item of result.results) {
    const packages = item.matchedPackages.map((physicalPackage) =>
      `${physicalPackage.providerLabelId}:${physicalPackage.trackingNumber}`
    ).join(",");
    console.log(
      `[ShipStation combined shipment recovery] ${item.outcome.toUpperCase()}`
        + ` wms=${item.candidate.wmsOrderId}`
        + ` order=${item.candidate.orderNumber}`
        + ` localShipments=${item.candidate.wmsShipmentIds.join(",")}`
        + ` localItems=${item.candidate.wmsShipmentItemIds.join(",")}`
        + ` packages=${packages || "none"}`
        + (item.error ? ` error=${JSON.stringify(item.error)}` : ""),
    );
  }
  console.log(JSON.stringify({
    candidates: result.candidates,
    matchedPackages: result.matchedPackages,
    enqueueRequests: result.enqueueRequests,
    noMatch: result.noMatch,
    errors: result.errors,
  }));
  if (result.errors > 0) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(parseFlags(process.argv.slice(2))).catch((error) => {
    console.error("[ShipStation combined shipment recovery] fatal:", error);
    process.exit(1);
  });
}
