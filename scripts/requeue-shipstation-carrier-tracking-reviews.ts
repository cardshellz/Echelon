import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CarrierTrackingRepository,
  RequeueReviewedTrackingSubscriptionsResult,
} from "../server/modules/shipping/carrier-tracking.repository";

type Mode = "dry-run" | "execute";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export interface Flags {
  help: boolean;
  mode: Mode;
  errorCode: string;
  carrierCode: string | null;
  httpStatus: number | null;
  limit: number;
  confirmCount: number | null;
  operator: string | null;
  reason: string | null;
  idempotencyKey: string | null;
  json: boolean;
}

export interface TrackingReviewCandidate {
  id: number;
  carrierCode: string;
  trackingNumber: string;
  errorCode: string;
  errorMessage: string | null;
  httpStatus: number | null;
  responseBody: string | null;
}

export interface TrackingReviewPreview {
  candidateCount: number;
  selectedCount: number;
  sample: TrackingReviewCandidate[];
}

interface Queryable {
  query(
    queryText: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/requeue-shipstation-carrier-tracking-reviews.ts --dry-run --error-code=SHIPSTATION_TRACKING_HTTP --http-status=400",
    "  npx tsx scripts/requeue-shipstation-carrier-tracking-reviews.ts --execute --error-code=SHIPSTATION_TRACKING_HTTP --http-status=400 --confirm-count=25 --operator=owner@cardshellz.com --reason=corrected-provider-configuration --idempotency-key=tracking-repair-2026-07-24-batch-1",
    "",
    "Flags:",
    "  --dry-run                 Preview only. Default.",
    "  --execute                 Requeue the exact guarded selection.",
    "  --error-code=TEXT         Required exact retained error code.",
    "  --carrier-code=TEXT       Optional exact carrier-code filter.",
    "  --http-status=N           Optional exact latest provider HTTP status.",
    "  --limit=N                 Max rows selected in this batch. Default 100, max 500.",
    "  --confirm-count=N         Required in execute mode; must match the selected dry-run count.",
    "  --operator=TEXT           Required in execute mode.",
    "  --reason=TEXT             Required in execute mode.",
    "  --idempotency-key=TEXT    Required in execute mode and reused only for the same batch.",
    "  --json                    Print machine-readable output.",
    "",
    "This command only moves corrected subscriptions from review to pending.",
    "Run the enrollment command afterward to call ShipStation.",
  ].join("\n");
}

export function parseFlags(argv: string[]): Flags {
  for (const arg of argv) {
    if (["--help", "-h", "--dry-run", "--execute", "--json"].includes(arg)) continue;
    if (/^--(error-code|carrier-code|http-status|limit|confirm-count|operator|reason|idempotency-key)=/.test(arg)) {
      continue;
    }
    throw new Error(`Unknown flag: ${arg}`);
  }
  if (argv.includes("--dry-run") && argv.includes("--execute")) {
    throw new Error("Choose either --dry-run or --execute, not both");
  }

  const mode: Mode = argv.includes("--execute") ? "execute" : "dry-run";
  const flags: Flags = {
    help: argv.includes("--help") || argv.includes("-h"),
    mode,
    errorCode: textFlag(argv, "--error-code=") ?? "",
    carrierCode: textFlag(argv, "--carrier-code="),
    httpStatus: optionalIntegerFlag(argv, "--http-status=", 100, 599),
    limit: integerFlag(argv, "--limit=", DEFAULT_LIMIT, 1, MAX_LIMIT),
    confirmCount: optionalIntegerFlag(argv, "--confirm-count=", 1, MAX_LIMIT),
    operator: textFlag(argv, "--operator="),
    reason: textFlag(argv, "--reason="),
    idempotencyKey: textFlag(argv, "--idempotency-key="),
    json: argv.includes("--json"),
  };
  if (!flags.help && !flags.errorCode) {
    throw new Error("--error-code is required");
  }
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

export async function loadTrackingReviewPreview(
  queryable: Queryable,
  flags: Flags,
): Promise<TrackingReviewPreview> {
  const values = [flags.errorCode, flags.carrierCode, flags.httpStatus, flags.limit];
  const countResult = await queryable.query(`
    WITH latest_attempt AS (
      SELECT DISTINCT ON (attempt.carrier_tracking_subscription_id)
        attempt.carrier_tracking_subscription_id,
        attempt.http_status
      FROM wms.carrier_tracking_subscription_attempts AS attempt
      ORDER BY
        attempt.carrier_tracking_subscription_id,
        attempt.attempt_number DESC,
        attempt.id DESC
    )
    SELECT COUNT(*)::integer AS candidate_count
    FROM wms.carrier_tracking_subscriptions AS subscription
    LEFT JOIN latest_attempt AS latest
      ON latest.carrier_tracking_subscription_id = subscription.id
    WHERE subscription.subscription_status = 'review'
      AND subscription.last_error_code = $1::text
      AND ($2::text IS NULL OR subscription.carrier_code = $2::text)
      AND ($3::integer IS NULL OR latest.http_status = $3::integer)
  `, values.slice(0, 3));
  const sampleResult = await queryable.query(`
    WITH latest_attempt AS (
      SELECT DISTINCT ON (attempt.carrier_tracking_subscription_id)
        attempt.carrier_tracking_subscription_id,
        attempt.http_status,
        NULLIF(BTRIM(attempt.response_evidence ->> 'responseBody'), '') AS response_body
      FROM wms.carrier_tracking_subscription_attempts AS attempt
      ORDER BY
        attempt.carrier_tracking_subscription_id,
        attempt.attempt_number DESC,
        attempt.id DESC
    )
    SELECT
      subscription.id,
      subscription.carrier_code,
      subscription.tracking_number,
      subscription.last_error_code,
      subscription.last_error_message,
      latest.http_status,
      latest.response_body
    FROM wms.carrier_tracking_subscriptions AS subscription
    LEFT JOIN latest_attempt AS latest
      ON latest.carrier_tracking_subscription_id = subscription.id
    WHERE subscription.subscription_status = 'review'
      AND subscription.last_error_code = $1::text
      AND ($2::text IS NULL OR subscription.carrier_code = $2::text)
      AND ($3::integer IS NULL OR latest.http_status = $3::integer)
    ORDER BY subscription.id
    LIMIT LEAST($4::integer, 25)
  `, values);

  const candidateCount = nonnegativeInteger(
    countResult.rows[0]?.candidate_count,
    "candidate_count",
  );
  return {
    candidateCount,
    selectedCount: Math.min(candidateCount, flags.limit),
    sample: sampleResult.rows.map((row) => ({
      id: positiveInteger(row.id, "subscription_id"),
      carrierCode: requiredString(row.carrier_code, "carrier_code"),
      trackingNumber: requiredString(row.tracking_number, "tracking_number"),
      errorCode: requiredString(row.last_error_code, "last_error_code"),
      errorMessage: optionalString(row.last_error_message),
      httpStatus: optionalHttpStatus(row.http_status),
      responseBody: optionalString(row.response_body),
    })),
  };
}

export async function runTrackingReviewRequeue(
  flags: Flags,
  dependencies: {
    preview(): Promise<TrackingReviewPreview>;
    repository: Pick<CarrierTrackingRepository, "requeueReviewedTrackingSubscriptions">;
    now(): Date;
  },
): Promise<{
  mode: Mode;
  preview: TrackingReviewPreview;
  result: RequeueReviewedTrackingSubscriptionsResult | null;
}> {
  const preview = await dependencies.preview();
  if (flags.mode === "dry-run") return { mode: flags.mode, preview, result: null };
  if (flags.confirmCount !== preview.selectedCount) {
    throw new Error(
      `--confirm-count=${flags.confirmCount} does not match selected dry-run count ${preview.selectedCount}`,
    );
  }
  const result = await dependencies.repository.requeueReviewedTrackingSubscriptions({
    errorCode: flags.errorCode,
    carrierCode: flags.carrierCode,
    httpStatus: flags.httpStatus,
    limit: flags.limit,
    expectedCount: flags.confirmCount,
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

function nonnegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${field} returned by tracking-subscription requeue query`);
  }
  return parsed;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = nonnegativeInteger(value, field);
  if (parsed === 0) {
    throw new Error(`Invalid ${field} returned by tracking-subscription requeue query`);
  }
  return parsed;
}

function requiredString(value: unknown, field: string): string {
  const parsed = optionalString(value);
  if (!parsed) {
    throw new Error(`Invalid ${field} returned by tracking-subscription requeue query`);
  }
  return parsed;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalHttpStatus(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 599) {
    throw new Error("Invalid http_status returned by tracking-subscription requeue query");
  }
  return parsed;
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
    const result = await runTrackingReviewRequeue(flags, {
      preview: () => loadTrackingReviewPreview(databaseModule.pool, flags),
      repository: repositoryModule.createDrizzleCarrierTrackingRepository(databaseModule.db),
      now: () => new Date(),
    });
    if (flags.json) console.log(JSON.stringify(result));
    else console.log(`[Carrier tracking subscription requeue] ${JSON.stringify(result, null, 2)}`);
  } finally {
    await databaseModule.pool.end();
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(`[Carrier tracking subscription requeue] fatal: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
