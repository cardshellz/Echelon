/**
 * Rehydrates ShipStation label direction when historic label observations did
 * not include `isReturnLabel`. The provider detail endpoint is authoritative.
 *
 * This never changes inventory, customer fulfillment, or channel fulfillment.
 * It only records corrected label evidence and resolves an exception when the
 * provider explicitly says that the label is return transport.
 *
 * Usage:
 *   npx tsx scripts/refresh-shipstation-label-directions.ts --dry-run --limit=100
 *   npx tsx scripts/refresh-shipstation-label-directions.ts --execute --limit=all --operator=owner@cardshellz.com
 *   npx tsx scripts/refresh-shipstation-label-directions.ts --dry-run --provider-shipment-id=448490235
 */

import { sql } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Mode = "dry-run" | "execute";

interface Flags {
  mode: Mode;
  limit: number | null;
  providerShipmentId: number | null;
  operator: string | null;
  json: boolean;
  help: boolean;
}

function parsePositiveInteger(value: string, flag: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${flag} must be a positive integer`);
  return Number(value);
}

function parseFlags(argv: readonly string[]): Flags {
  let mode: Mode = "dry-run";
  let limit: number | null = 100;
  let providerShipmentId: number | null = null;
  let operator: string | null = null;
  let json = false;
  let help = false;

  for (const arg of argv) {
    if (arg === "--dry-run") mode = "dry-run";
    else if (arg === "--execute") mode = "execute";
    else if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg.startsWith("--limit=")) {
      const value = arg.slice("--limit=".length);
      limit = value === "all" ? null : parsePositiveInteger(value, "--limit");
    } else if (arg.startsWith("--provider-shipment-id=")) {
      providerShipmentId = parsePositiveInteger(
        arg.slice("--provider-shipment-id=".length),
        "--provider-shipment-id",
      );
    } else if (arg.startsWith("--operator=")) {
      const value = arg.slice("--operator=".length).trim();
      if (!value) throw new Error("--operator cannot be blank");
      operator = value;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (mode === "execute" && !operator) {
    throw new Error("--operator is required with --execute");
  }
  return { mode, limit, providerShipmentId, operator, json, help };
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/refresh-shipstation-label-directions.ts --dry-run --limit=100",
    "  npx tsx scripts/refresh-shipstation-label-directions.ts --execute --limit=all --operator=owner@cardshellz.com",
    "  npx tsx scripts/refresh-shipstation-label-directions.ts --dry-run --provider-shipment-id=448490235",
    "",
    "Flags:",
    "  --dry-run                         Fetch and classify only. Default.",
    "  --execute                         Persist provider-declared label direction.",
    "  --limit=N|all                     Maximum labels to inspect. Default 100.",
    "  --provider-shipment-id=N          Restrict to one ShipStation shipment.",
    "  --operator=TEXT                   Required with --execute for audit attribution.",
    "  --json                            Print a machine-readable summary.",
  ].join("\n");
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const flags = parseFlags(argv);
  if (flags.help) {
    console.log(usage());
    return;
  }

  const [
    databaseModule,
    shipStationModule,
    trackingRepositoryModule,
    trackingServiceModule,
    unmappedModule,
  ] = await Promise.all([
    import("../server/db"),
    import("../server/modules/oms/shipstation.service"),
    import("../server/modules/shipping/carrier-tracking.repository"),
    import("../server/modules/shipping/carrier-tracking.service"),
    import("../server/modules/oms/shipstation-unmapped-physical"),
  ]);

  const { db, pool } = databaseModule;
  const whereShipment = flags.providerShipmentId === null
    ? sql``
    : sql`AND label.provider_label_id = ${String(flags.providerShipmentId)}`;
  const limit = flags.limit === null ? sql`` : sql`LIMIT ${flags.limit}`;

  const candidatesResult: any = await db.execute(sql`
    SELECT label.provider_label_id
    FROM wms.shipping_provider_labels AS label
    WHERE label.provider = 'shipstation'
      AND label.label_direction IN ('outbound', 'unknown')
      AND label.label_status IN ('active', 'unknown')
      AND NOT EXISTS (
        SELECT 1
        FROM wms.shipping_provider_label_events AS event
        WHERE event.shipping_provider_label_id = label.id
          AND event.sanitized_payload ? 'isReturnLabel'
      )
      ${whereShipment}
    ORDER BY label.id ASC
    ${limit}
  `);
  const candidates = (candidatesResult.rows ?? []).map((row: any) =>
    parsePositiveInteger(String(row.provider_label_id), "provider_label_id"),
  );

  const shipStation = shipStationModule.createShipStationService(db);
  if (!shipStation.isConfigured()) throw new Error("ShipStation is not configured");
  const carrierTracking = new trackingServiceModule.CarrierTrackingService({
    repository: trackingRepositoryModule.createDrizzleCarrierTrackingRepository(db),
    clock: trackingServiceModule.systemCarrierTrackingClock,
    logger: trackingServiceModule.makeCarrierTrackingLogger(),
  });

  let outbound = 0;
  let returns = 0;
  let missing = 0;
  let updated = 0;
  let returnExceptionsChecked = 0;
  const failures: Array<{ providerShipmentId: number; message: string }> = [];

  for (const providerShipmentId of candidates) {
    try {
      const shipment = await shipStation.getShipmentById(providerShipmentId);
      if (!shipment || typeof shipment.isReturnLabel !== "boolean") {
        missing += 1;
        continue;
      }
      if (shipment.isReturnLabel) returns += 1;
      else outbound += 1;

      if (flags.mode === "execute") {
        await carrierTracking.observeShipStationLabel(shipment);
        updated += 1;
        if (shipment.isReturnLabel) {
          await unmappedModule.resolveShipStationUnmappedPhysicalExceptionForReturnLabel(db, {
            shipment,
            resolvedBy: flags.operator!,
            notes: "Historical ShipStation detail refresh confirmed return-label direction.",
          });
          returnExceptionsChecked += 1;
        }
      }

      if (!flags.json) {
        console.log(
          `[ShipStation label direction refresh] ${flags.mode === "execute" ? "UPDATE" : "PLAN"} ` +
          `shipment=${providerShipmentId} direction=${shipment.isReturnLabel ? "return" : "outbound"}`,
        );
      }
    } catch (error) {
      failures.push({
        providerShipmentId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const summary = {
    mode: flags.mode,
    candidates: candidates.length,
    outbound,
    returns,
    missing,
    updated,
    returnExceptionsChecked,
    failures,
  };
  if (flags.json) console.log(JSON.stringify(summary));
  else console.log(`[ShipStation label direction refresh] complete ${JSON.stringify(summary)}`);
  if (failures.length > 0) process.exitCode = 2;
  await pool.end();
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((error) => {
    console.error(`[ShipStation label direction refresh] fatal: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}

export { main, parseFlags };