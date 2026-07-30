import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runHistoricalShipStationSplitRepair,
  type HistoricalSplitRepairFlags,
  type HistoricalSplitRepairMode,
} from "../server/modules/oms/historical-shipstation-split-repair.service";

const DEFAULT_LIMIT = 25;
const DEFAULT_DELAY_MS = 250;

export interface CliFlags extends HistoricalSplitRepairFlags {
  readonly help: boolean;
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/repair-historical-shipstation-splits.ts --dry-run --limit=25",
    "  npx tsx scripts/repair-historical-shipstation-splits.ts --dry-run --limit=all --json",
    "  npx tsx scripts/repair-historical-shipstation-splits.ts --execute --limit=all --confirm-count=N --operator=EMAIL --reason=TEXT --idempotency-key=KEY",
    "",
    "Flags:",
    "  --dry-run                    Fetch, classify, and prove only. Default.",
    "  --execute                    Apply only proof-complete repairs.",
    "  --limit=N|all                Max unique provider packages. Default 25.",
    "  --provider-shipment-id=N     Restrict to one ShipStation shipment id.",
    "  --confirm-count=N            Required for execute; must equal selected package count.",
    "  --operator=IDENTITY          Required for execute audit trail.",
    "  --reason=TEXT                Required for execute audit trail.",
    "  --idempotency-key=KEY        Required for execute; deterministically identifies the run.",
    "  --delay-ms=N                 Delay between ShipStation lookups. Default 250.",
    "  --json                       Print only the summary JSON.",
    "  --help                       Show this help.",
  ].join("\n");
}

function valueFor(argv: readonly string[], prefix: string): string | null {
  const arg = argv.find((candidate) => candidate.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function optionalPositiveInteger(
  value: string | null,
  flag: string,
  fallback: number | null,
  allowAll: boolean,
): number | null {
  if (value === null) return fallback;
  if (allowAll && value === "all") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer${allowAll ? " or all" : ""}`);
  }
  return parsed;
}

function nonnegativeInteger(value: string | null, flag: string, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

export function parseFlags(argv: readonly string[]): CliFlags {
  const dryRun = argv.includes("--dry-run");
  const execute = argv.includes("--execute");
  if (dryRun && execute) throw new Error("Cannot pass both --dry-run and --execute");
  const known = /^(--help|-h|--dry-run|--execute|--limit=|--provider-shipment-id=|--confirm-count=|--operator=|--reason=|--idempotency-key=|--delay-ms=|--json$)/;
  const unknown = argv.find((arg) => !known.test(arg));
  if (unknown) throw new Error(`Unknown flag: ${unknown}`);

  const mode: HistoricalSplitRepairMode = execute ? "execute" : "dry-run";
  const flags: CliFlags = Object.freeze({
    help: argv.includes("--help") || argv.includes("-h"),
    mode,
    limit: optionalPositiveInteger(valueFor(argv, "--limit="), "--limit", DEFAULT_LIMIT, true),
    providerShipmentId: optionalPositiveInteger(
      valueFor(argv, "--provider-shipment-id="),
      "--provider-shipment-id",
      null,
      false,
    ),
    confirmCount: optionalPositiveInteger(
      valueFor(argv, "--confirm-count="),
      "--confirm-count",
      null,
      false,
    ),
    operator: valueFor(argv, "--operator="),
    reason: valueFor(argv, "--reason="),
    idempotencyKey: valueFor(argv, "--idempotency-key="),
    delayMs: nonnegativeInteger(valueFor(argv, "--delay-ms="), "--delay-ms", DEFAULT_DELAY_MS),
    json: argv.includes("--json"),
  });
  if (mode === "execute" && flags.confirmCount === null) {
    throw new Error("--confirm-count is required with --execute");
  }
  return flags;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const flags = parseFlags(argv);
  if (flags.help) {
    console.log(usage());
    return;
  }

  const [
    { db, pool },
    { createShipStationService },
    { createHistoricalShipStationSplitRepairRepository },
    { createDrizzleCarrierTrackingRepository },
    { CarrierTrackingService, makeCarrierTrackingLogger, systemCarrierTrackingClock },
    { createShipStationTrackingEventsClient },
  ] = await Promise.all([
    import("../server/db"),
    import("../server/modules/oms/shipstation.service"),
    import("../server/modules/oms/historical-shipstation-split-repair.repository"),
    import("../server/modules/shipping/carrier-tracking.repository"),
    import("../server/modules/shipping/carrier-tracking.service"),
    import("../server/modules/shipping/shipstation-tracking-events.client"),
  ]);

  const repository = createHistoricalShipStationSplitRepairRepository(pool);
  const shipStation = createShipStationService(db);
  const carrierTracking = new CarrierTrackingService({
    repository: createDrizzleCarrierTrackingRepository(db),
    clock: systemCarrierTrackingClock,
    logger: makeCarrierTrackingLogger(),
    trackingEventsClient: createShipStationTrackingEventsClient(),
  });
  try {
    const summary = await runHistoricalShipStationSplitRepair(flags, {
      loadRetryCandidates: repository.loadRetryCandidates,
      lookupProviderShipment: async (providerShipmentId) =>
        shipStation.getShipmentById(providerShipmentId),
      inspectPackages: repository.inspectPackages,
      applyComponent: repository.applyComponent,
      reconcileProviderPackage: async (applied, providerPackage) => {
        await carrierTracking.observeShipStationLabel({
          shipmentId: providerPackage.providerShipmentId,
          orderId: providerPackage.providerOrderId,
          orderKey: providerPackage.providerOrderKey,
          orderNumber: providerPackage.orderNumber,
          trackingNumber: providerPackage.trackingNumber,
          carrierCode: providerPackage.carrierCode,
          serviceCode: providerPackage.serviceCode,
          shipDate: providerPackage.shippedAt.toISOString(),
          voidDate: null,
          isReturnLabel: false,
          shipmentItems: providerPackage.items.map((item) => ({
            lineItemKey: `wms-item-${item.sourceShipmentItemId}`,
            quantity: item.quantity,
          })),
        });
        const links = await carrierTracking.reconcileShipStationLabel(
          String(providerPackage.providerShipmentId),
        );
        if (links.totalLinks <= 0) {
          throw new Error(
            `Provider shipment ${providerPackage.providerShipmentId} did not link to any repaired WMS package`,
          );
        }
        const exactTargetLinkCount = await repository.proveProviderPackageLinks(applied);

        try {
          const hydration = await carrierTracking.hydrateShipStationTrackingIdentity({
            carrierCode: providerPackage.carrierCode,
            trackingNumber: providerPackage.trackingNumber,
          });
          return Object.freeze({
            providerLabelLinkCount: exactTargetLinkCount,
            dispatchEvidence: hydration.dispatchEvidence,
            dispatchCommandCreated: hydration.dispatchCommandInserted,
            trackingHydrationError: null,
          });
        } catch (error) {
          return Object.freeze({
            providerLabelLinkCount: exactTargetLinkCount,
            dispatchEvidence: null,
            dispatchCommandCreated: false,
            trackingHydrationError: error instanceof Error ? error.message : String(error),
          });
        }
      },
      finalizeMappedPackage: repository.finalizeMappedPackage,
      finalizeRepairedPackage: async (applied, packagePlan, materialized, audit) =>
        repository.finalizeRepairedPackage(
          applied,
          packagePlan,
          materialized.physicalShipmentId,
          audit,
        ),
      finalizeNonOutboundPackage: repository.finalizeNonOutboundPackage,
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      now: () => new Date(),
      log: flags.json ? () => undefined : console.log,
    });
    console.log(JSON.stringify(summary));
    if (summary.failures.length > 0 || summary.unsafe > 0) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;
if (isMain) {
  main().catch((error) => {
    console.error("[Historical ShipStation split repair] fatal:", error);
    process.exit(1);
  });
}