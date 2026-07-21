/**
 * Enroll existing ShipStation label artifacts in the documented ShipEngine
 * carrier-tracking webhook feed.
 *
 * This command is shadow-only. It writes tracking subscription state and calls
 * the provider enrollment endpoint; it never changes fulfillment or inventory.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CarrierTrackingSubscriptionSweepResult } from "../server/modules/shipping/carrier-tracking.service";

type Mode = "dry-run" | "execute";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const DEFAULT_BATCHES = 1;
const MAX_BATCHES = 100;
const DEFAULT_BATCH_DELAY_MS = 1_000;
const MAX_BATCH_DELAY_MS = 60_000;

export interface Flags {
  help: boolean;
  mode: Mode;
  limit: number;
  batches: number;
  batchDelayMs: number;
  json: boolean;
}

export interface TrackingEnrollmentPreview {
  activeOrUnknownLabels: number;
  labelsMissingCarrierCode: number;
  labelsMissingSubscriptionLink: number;
  subscriptionsByStatus: Record<string, number>;
  dueSubscriptions: number;
}

export interface TrackingEnrollmentRunResult {
  mode: Mode;
  before: TrackingEnrollmentPreview;
  after: TrackingEnrollmentPreview | null;
  batchesRun: number;
  summary: CarrierTrackingSubscriptionSweepResult;
  stoppedReason: "dry_run" | "no_due_work" | "batch_limit_reached";
}

export interface TrackingEnrollmentDependencies {
  preview(): Promise<TrackingEnrollmentPreview>;
  isProviderConfigured(): boolean;
  sweep(limit: number): Promise<CarrierTrackingSubscriptionSweepResult>;
  sleep(milliseconds: number): Promise<void>;
  log(message: string): void;
}

interface Queryable {
  query(queryText: string): Promise<{ rows: Record<string, unknown>[] }>;
}

export function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/enroll-shipstation-carrier-tracking.ts --dry-run",
    "  npx tsx scripts/enroll-shipstation-carrier-tracking.ts --execute --limit=25 --batches=10",
    "",
    "Flags:",
    "  --dry-run             Report readiness without writes or provider calls. Default.",
    "  --execute             Persist subscriptions and call the provider enrollment API.",
    "  --limit=N             Subscriptions per batch. Default 25, max 100.",
    "  --batches=N           Maximum batches in this run. Default 1, max 100.",
    "  --batch-delay-ms=N    Delay between batches. Default 1000, max 60000.",
    "  --json                Print the final result as JSON.",
    "",
    "Environment:",
    "  DATABASE_URL or EXTERNAL_DATABASE_URL",
    "  SHIPSTATION_TRACKING_API_KEY",
    "",
    "Execute mode is shadow-only: it cannot update fulfillment or inventory.",
  ].join("\n");
}

export function parseFlags(argv: string[]): Flags {
  for (const arg of argv) {
    if (["--help", "-h", "--dry-run", "--execute", "--json"].includes(arg)) continue;
    if (/^--(limit|batches|batch-delay-ms)=/.test(arg)) continue;
    throw new Error(`Unknown flag: ${arg}`);
  }
  if (argv.includes("--dry-run") && argv.includes("--execute")) {
    throw new Error("Choose either --dry-run or --execute, not both");
  }

  return {
    help: argv.includes("--help") || argv.includes("-h"),
    mode: argv.includes("--execute") ? "execute" : "dry-run",
    limit: integerFlag(argv, "--limit=", DEFAULT_LIMIT, 1, MAX_LIMIT),
    batches: integerFlag(argv, "--batches=", DEFAULT_BATCHES, 1, MAX_BATCHES),
    batchDelayMs: integerFlag(
      argv,
      "--batch-delay-ms=",
      DEFAULT_BATCH_DELAY_MS,
      0,
      MAX_BATCH_DELAY_MS,
    ),
    json: argv.includes("--json"),
  };
}

export async function loadTrackingEnrollmentPreview(
  queryable: Queryable,
): Promise<TrackingEnrollmentPreview> {
  const labelResult = await queryable.query(`
    WITH eligible_labels AS (
      SELECT label.id, label.carrier
      FROM wms.shipping_provider_labels AS label
      WHERE label.provider = 'shipstation'
        AND label.label_status IN ('active', 'unknown')
    )
    SELECT
      COUNT(*)::integer AS active_or_unknown_labels,
      COUNT(*) FILTER (
        WHERE NULLIF(BTRIM(eligible.carrier), '') IS NULL
      )::integer AS labels_missing_carrier_code,
      COUNT(*) FILTER (
        WHERE NULLIF(BTRIM(eligible.carrier), '') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM wms.carrier_tracking_subscription_labels AS subscription_label
            WHERE subscription_label.shipping_provider_label_id = eligible.id
          )
      )::integer AS labels_missing_subscription_link
    FROM eligible_labels AS eligible
  `);
  const subscriptionResult = await queryable.query(`
    SELECT
      subscription.subscription_status,
      COUNT(*)::integer AS status_count,
      COUNT(*) FILTER (
        WHERE (
          subscription.subscription_status IN ('pending', 'retry')
          AND subscription.next_attempt_at <= NOW()
        ) OR (
          subscription.subscription_status = 'processing'
          AND subscription.lease_expires_at <= NOW()
        )
      )::integer AS due_count
    FROM wms.carrier_tracking_subscriptions AS subscription
    GROUP BY subscription.subscription_status
    ORDER BY subscription.subscription_status
  `);

  const labelRow = labelResult.rows[0] ?? {};
  const subscriptionsByStatus: Record<string, number> = {};
  let dueSubscriptions = 0;
  for (const row of subscriptionResult.rows) {
    const status = requiredString(row.subscription_status, "subscription_status");
    subscriptionsByStatus[status] = nonnegativeInteger(row.status_count, "status_count");
    dueSubscriptions += nonnegativeInteger(row.due_count, "due_count");
  }

  return {
    activeOrUnknownLabels: nonnegativeInteger(
      labelRow.active_or_unknown_labels,
      "active_or_unknown_labels",
    ),
    labelsMissingCarrierCode: nonnegativeInteger(
      labelRow.labels_missing_carrier_code,
      "labels_missing_carrier_code",
    ),
    labelsMissingSubscriptionLink: nonnegativeInteger(
      labelRow.labels_missing_subscription_link,
      "labels_missing_subscription_link",
    ),
    subscriptionsByStatus,
    dueSubscriptions,
  };
}

export async function runTrackingEnrollment(
  flags: Flags,
  dependencies: TrackingEnrollmentDependencies,
): Promise<TrackingEnrollmentRunResult> {
  const before = await dependencies.preview();
  const summary = emptySweepSummary(dependencies.isProviderConfigured());
  if (flags.mode === "dry-run") {
    return {
      mode: flags.mode,
      before,
      after: null,
      batchesRun: 0,
      summary,
      stoppedReason: "dry_run",
    };
  }
  if (!dependencies.isProviderConfigured()) {
    throw new Error("SHIPSTATION_TRACKING_API_KEY is required before execute mode can write enrollment state");
  }

  let batchesRun = 0;
  let stoppedReason: TrackingEnrollmentRunResult["stoppedReason"] = "batch_limit_reached";
  for (let batch = 1; batch <= flags.batches; batch += 1) {
    const batchResult = await dependencies.sweep(flags.limit);
    batchesRun += 1;
    mergeSweepSummary(summary, batchResult);
    dependencies.log(`[Carrier tracking enrollment] BATCH ${batch}/${flags.batches} ${JSON.stringify(batchResult)}`);

    const workObserved = batchResult.subscriptionsPrepared
      + batchResult.subscriptionLabelLinksPrepared
      + batchResult.subscriptionsClaimed;
    if (workObserved === 0) {
      stoppedReason = "no_due_work";
      break;
    }
    if (batch < flags.batches && flags.batchDelayMs > 0) {
      await dependencies.sleep(flags.batchDelayMs);
    }
  }

  return {
    mode: flags.mode,
    before,
    after: await dependencies.preview(),
    batchesRun,
    summary,
    stoppedReason,
  };
}

function integerFlag(
  argv: string[],
  prefix: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = argv.find((arg) => arg.startsWith(prefix));
  if (!raw) return fallback;
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

function nonnegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${field} returned by carrier tracking enrollment query`);
  }
  return parsed;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${field} returned by carrier tracking enrollment query`);
  }
  return value.trim();
}

function emptySweepSummary(configured: boolean): CarrierTrackingSubscriptionSweepResult {
  return {
    subscriptionsPrepared: 0,
    subscriptionLabelLinksPrepared: 0,
    subscriptionsClaimed: 0,
    subscriptionsActivated: 0,
    subscriptionsRetryScheduled: 0,
    subscriptionsReviewRequired: 0,
    subscriptionClientConfigured: configured,
    errors: 0,
  };
}

function mergeSweepSummary(
  target: CarrierTrackingSubscriptionSweepResult,
  batch: CarrierTrackingSubscriptionSweepResult,
): void {
  target.subscriptionsPrepared += batch.subscriptionsPrepared;
  target.subscriptionLabelLinksPrepared += batch.subscriptionLabelLinksPrepared;
  target.subscriptionsClaimed += batch.subscriptionsClaimed;
  target.subscriptionsActivated += batch.subscriptionsActivated;
  target.subscriptionsRetryScheduled += batch.subscriptionsRetryScheduled;
  target.subscriptionsReviewRequired += batch.subscriptionsReviewRequired;
  target.subscriptionClientConfigured = target.subscriptionClientConfigured
    && batch.subscriptionClientConfigured;
  target.errors += batch.errors;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const [databaseModule, repositoryModule, serviceModule, clientModule] = await Promise.all([
    import("../server/db"),
    import("../server/modules/shipping/carrier-tracking.repository"),
    import("../server/modules/shipping/carrier-tracking.service"),
    import("../server/modules/shipping/shipstation-tracking-subscriptions.client"),
  ]);
  const client = clientModule.createShipStationTrackingSubscriptionsClient();
  const service = new serviceModule.CarrierTrackingService({
    repository: repositoryModule.createDrizzleCarrierTrackingRepository(databaseModule.db),
    clock: serviceModule.systemCarrierTrackingClock,
    logger: serviceModule.makeCarrierTrackingLogger(),
    subscriptionClient: client,
    subscriptionLeaseOwner: `carrier-tracking-backfill:${process.pid}`,
  });

  try {
    const result = await runTrackingEnrollment(flags, {
      preview: () => loadTrackingEnrollmentPreview(databaseModule.pool),
      isProviderConfigured: () => client.isConfigured(),
      sweep: (limit) => service.reconcileTrackingSubscriptions(limit),
      sleep: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
      log: (message) => console.log(message),
    });
    if (flags.json) console.log(JSON.stringify(result));
    else console.log(`[Carrier tracking enrollment] complete ${JSON.stringify(result)}`);
    if (result.summary.errors > 0 || result.summary.subscriptionsReviewRequired > 0) {
      process.exitCode = 2;
    }
  } finally {
    await databaseModule.pool.end();
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(`[Carrier tracking enrollment] fatal: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
