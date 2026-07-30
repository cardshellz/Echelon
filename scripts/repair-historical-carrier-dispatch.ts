import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CarrierTrackingRepository,
  HistoricalCarrierDispatchRepairCohort,
  HistoricalCarrierDispatchRepairPreview,
  RequeueReviewedCarrierDispatchCommandsResult,
} from "../server/modules/shipping/carrier-tracking.repository";

type Mode = "dry-run" | "execute";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export interface Flags {
  help: boolean;
  mode: Mode;
  limit: number;
  cohort: HistoricalCarrierDispatchRepairCohort | null;
  confirmCount: number | null;
  operator: string | null;
  reason: string | null;
  idempotencyKey: string | null;
  json: boolean;
}

export function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/repair-historical-carrier-dispatch.ts --dry-run --limit=100",
    "  npx tsx scripts/repair-historical-carrier-dispatch.ts --execute --limit=100 --confirm-count=12 --operator=owner@cardshellz.com --reason=post-authority-repair --idempotency-key=carrier-dispatch-repair-2026-07-24-batch-1",
    "",
    "Flags:",
    "  --dry-run                 Preview only. Default.",
    "  --execute                 Requeue the exact guarded selection.",
    "  --limit=N                 Max rows selected in this batch. Default 100, max 500.",
    "  --cohort=NAME             Restrict repair to one proven failure cohort.",
    "  --confirm-count=N         Required in execute mode; must match the selected dry-run count.",
    "  --operator=TEXT           Required in execute mode.",
    "  --reason=TEXT             Required in execute mode.",
    "  --idempotency-key=TEXT    Required in execute mode and reused only for the same batch.",
    "  --json                    Print machine-readable output.",
    "",
    "Supported cohorts: active_combined_package_resolution,",
    "aggregate_package_identity_conflict, immutable_command_request_conflict,",
    "legacy_outbound_shipment_identity_conflict.",
    "Unresolved package-resolution reviews are intentionally excluded.",
    "",
    "Only known historical carrier-dispatch failures with confirmed carrier",
    "evidence, a linked non-voided ShipStation label, and a repaired code path",
    "are eligible. Requeued commands are processed by the normal scheduler.",
  ].join("\n");
}

export function parseFlags(argv: string[]): Flags {
  for (const arg of argv) {
    if (["--help", "-h", "--dry-run", "--execute", "--json"].includes(arg)) continue;
    if (/^--(limit|cohort|confirm-count|operator|reason|idempotency-key)=/.test(arg)) continue;
    throw new Error(`Unknown flag: ${arg}`);
  }
  if (argv.includes("--dry-run") && argv.includes("--execute")) {
    throw new Error("Choose either --dry-run or --execute, not both");
  }

  const mode: Mode = argv.includes("--execute") ? "execute" : "dry-run";
  const flags: Flags = {
    help: argv.includes("--help") || argv.includes("-h"),
    mode,
    limit: integerFlag(argv, "--limit=", DEFAULT_LIMIT, 1, MAX_LIMIT),
    cohort: cohortFlag(argv),
    confirmCount: optionalIntegerFlag(argv, "--confirm-count=", 1, MAX_LIMIT),
    operator: textFlag(argv, "--operator="),
    reason: textFlag(argv, "--reason="),
    idempotencyKey: textFlag(argv, "--idempotency-key="),
    json: argv.includes("--json"),
  };
  if (mode === "execute") {
    for (const [name, value] of [
      ["--confirm-count", flags.confirmCount],
      ["--operator", flags.operator],
      ["--reason", flags.reason],
      ["--idempotency-key", flags.idempotencyKey],
    ] as const) {
      if (value === null) throw new Error(`${name} is required in execute mode`);
    }
  }
  return flags;
}

export async function runHistoricalCarrierDispatchRepair(
  flags: Flags,
  dependencies: {
    repository: Pick<
      CarrierTrackingRepository,
      "previewReviewedCarrierDispatchCommands" | "requeueReviewedCarrierDispatchCommands"
    >;
    now(): Date;
  },
): Promise<{
  mode: Mode;
  preview: HistoricalCarrierDispatchRepairPreview;
  result: RequeueReviewedCarrierDispatchCommandsResult | null;
}> {
  const preview = await dependencies.repository.previewReviewedCarrierDispatchCommands(
    flags.limit,
    flags.cohort,
  );
  if (flags.mode === "dry-run") return { mode: flags.mode, preview, result: null };
  if (flags.confirmCount !== preview.selectedCount) {
    throw new Error(
      `--confirm-count=${flags.confirmCount} does not match selected dry-run count ${preview.selectedCount}`,
    );
  }
  const result = await dependencies.repository.requeueReviewedCarrierDispatchCommands({
    limit: flags.limit,
    expectedCount: flags.confirmCount,
    cohort: flags.cohort,
    operator: flags.operator!,
    reason: flags.reason!,
    idempotencyKey: flags.idempotencyKey!,
    requeuedAt: dependencies.now(),
  });
  return { mode: flags.mode, preview, result };
}

function textFlag(argv: string[], prefix: string): string | null {
  const raw = argv.find((arg) => arg.startsWith(prefix));
  if (!raw) return null;
  const value = raw.slice(prefix.length).trim();
  if (!value) throw new Error(`${prefix.slice(0, -1)} must not be blank`);
  return value;
}

const REPAIR_COHORTS = new Set<HistoricalCarrierDispatchRepairCohort>([
  "active_combined_package_resolution",
  "aggregate_package_identity_conflict",
  "immutable_command_request_conflict",
  "legacy_outbound_shipment_identity_conflict",
]);

function cohortFlag(argv: string[]): HistoricalCarrierDispatchRepairCohort | null {
  const value = textFlag(argv, "--cohort=");
  if (value === null) return null;
  if (!REPAIR_COHORTS.has(value as HistoricalCarrierDispatchRepairCohort)) {
    throw new Error(`Unsupported --cohort=${value}`);
  }
  return value as HistoricalCarrierDispatchRepairCohort;
}

function integerFlag(
  argv: string[],
  prefix: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return optionalIntegerFlag(argv, prefix, minimum, maximum) ?? fallback;
}

function optionalIntegerFlag(
  argv: string[],
  prefix: string,
  minimum: number,
  maximum: number,
): number | null {
  const raw = argv.find((arg) => arg.startsWith(prefix));
  if (!raw) return null;
  const valueText = raw.slice(prefix.length);
  if (!/^\d+$/.test(valueText)) {
    throw new Error(`${prefix.slice(0, -1)} must be an integer from ${minimum} through ${maximum}`);
  }
  const value = Number(valueText);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${prefix.slice(0, -1)} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }
  const [databaseModule, repositoryModule] = await Promise.all([
    import("../server/db"),
    import("../server/modules/shipping/carrier-tracking.repository"),
  ]);
  try {
    const result = await runHistoricalCarrierDispatchRepair(flags, {
      repository: repositoryModule.createDrizzleCarrierTrackingRepository(databaseModule.db),
      now: () => new Date(),
    });
    if (flags.json) console.log(JSON.stringify(result));
    else console.log(`[Historical carrier dispatch repair] ${JSON.stringify(result, null, 2)}`);
  } finally {
    await databaseModule.pool.end();
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(`[Historical carrier dispatch repair] fatal: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
