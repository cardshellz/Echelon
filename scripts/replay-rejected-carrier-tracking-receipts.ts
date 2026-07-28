import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CARRIER_TRACKING_PARSER_VERSION,
  normalizeShipStationTrackingWebhook,
  type VerifiedCarrierWebhookReceipt,
} from "../server/modules/shipping/carrier-tracking.domain";
import type {
  CarrierTrackingIngestResult,
  CarrierTrackingService,
  CarrierTrackingWebhookReplayContext,
} from "../server/modules/shipping/carrier-tracking.service";

type Mode = "dry-run" | "execute";

const LEGACY_PARSER_VERSION = "shipstation-api-track-v1";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 5_000;
const QUERY_PAGE_SIZE = 500;
const SAMPLE_LIMIT = 25;

export interface Flags {
  help: boolean;
  mode: Mode;
  limit: number | null;
  confirmCount: number | null;
  operator: string | null;
  reason: string | null;
  idempotencyKey: string | null;
  json: boolean;
}

interface Queryable {
  query(
    queryText: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

interface ReplayService {
  replayVerifiedShipStationWebhook(
    rawPayload: unknown,
    receipt: VerifiedCarrierWebhookReceipt,
    context: CarrierTrackingWebhookReplayContext,
  ): Promise<CarrierTrackingIngestResult>;
}

interface ReplayCandidate {
  receiptId: number;
  receipt: VerifiedCarrierWebhookReceipt;
  rawPayload: unknown;
  trackingNumber: string;
  providerStatusCode: string;
  dispatchEvidence: string;
}

export interface ReplayPreview {
  scannedRows: number;
  selectedCount: number;
  stillInvalid: number;
  integrityFailures: number;
  selectedSample: Array<{
    receiptId: number;
    trackingSuffix: string;
    providerStatusCode: string;
    dispatchEvidence: string;
  }>;
  excludedSample: Array<{
    receiptId: number;
    classification: "still_invalid" | "integrity_failure";
    reason: string;
  }>;
}

interface ReplayPlan {
  preview: ReplayPreview;
  candidates: ReplayCandidate[];
}

export interface ReplayExecutionSummary {
  mode: Mode;
  preview: ReplayPreview;
  normalized: number;
  eventsInserted: number;
  parseAttemptsInserted: number;
  alreadyProcessed: number;
  failed: number;
  failures: Array<{ receiptId: number; reason: string }>;
}

export function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/replay-rejected-carrier-tracking-receipts.ts --dry-run --limit=100",
    "  npx tsx scripts/replay-rejected-carrier-tracking-receipts.ts --execute --limit=100 --confirm-count=100 --operator=owner@cardshellz.com --reason=shipstation-parser-v2-repair --idempotency-key=carrier-tracking-parser-v2-batch-1",
    "",
    "Flags:",
    "  --dry-run                 Validate retained receipts without writing. Default.",
    "  --execute                 Append v2 parse/events through carrier-tracking authority.",
    "  --limit=N|all             Max eligible receipts selected. Default 100, max 5000.",
    "  --confirm-count=N         Required in execute mode; must match dry-run selectedCount.",
    "  --operator=TEXT           Required in execute mode and retained in parse audit evidence.",
    "  --reason=TEXT             Required in execute mode and retained in parse audit evidence.",
    "  --idempotency-key=TEXT    Required in execute mode and retained in parse audit evidence.",
    "  --json                    Print one machine-readable summary.",
    "",
    `Only ${LEGACY_PARSER_VERSION} receipts rejected as INVALID_CARRIER_TRACKING_PAYLOAD`,
    `without a ${CARRIER_TRACKING_PARSER_VERSION} parse attempt are considered. Exact raw bytes`,
    "must still match their retained SHA-256 hash before replay. Normal reconciliation",
    "then matches the event and promotes confirmed carrier dispatch idempotently.",
  ].join("\n");
}

export function parseFlags(argv: string[]): Flags {
  for (const arg of argv) {
    if (["--help", "-h", "--dry-run", "--execute", "--json"].includes(arg)) continue;
    if (/^--(limit|confirm-count|operator|reason|idempotency-key)=/.test(arg)) continue;
    throw new Error(`Unknown flag: ${arg}`);
  }
  if (argv.includes("--dry-run") && argv.includes("--execute")) {
    throw new Error("Choose either --dry-run or --execute, not both");
  }

  const mode: Mode = argv.includes("--execute") ? "execute" : "dry-run";
  const flags: Flags = {
    help: argv.includes("--help") || argv.includes("-h"),
    mode,
    limit: limitFlag(argv),
    confirmCount: optionalIntegerFlag(argv, "--confirm-count=", 0, MAX_LIMIT),
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

export async function buildReplayPlan(
  queryable: Queryable,
  flags: Pick<Flags, "limit">,
): Promise<ReplayPlan> {
  const candidates: ReplayCandidate[] = [];
  const preview: ReplayPreview = {
    scannedRows: 0,
    selectedCount: 0,
    stillInvalid: 0,
    integrityFailures: 0,
    selectedSample: [],
    excludedSample: [],
  };
  let afterReceiptId = 0;

  while (flags.limit === null || candidates.length < flags.limit) {
    const result = await queryable.query(`
      SELECT
        receipt.id,
        receipt.provider,
        receipt.receipt_hash,
        receipt.signature_algorithm,
        receipt.signature_key_id,
        receipt.signature_timestamp_raw,
        receipt.signature_timestamp_at,
        receipt.raw_body_base64,
        receipt.raw_body_hash,
        receipt.signature_base64,
        receipt.signature_hash,
        receipt.verified_at
      FROM wms.carrier_tracking_webhook_receipts AS receipt
      WHERE receipt.id > $1::bigint
        AND EXISTS (
          SELECT 1
          FROM wms.carrier_tracking_webhook_receipt_parses AS legacy_parse
          WHERE legacy_parse.carrier_tracking_webhook_receipt_id = receipt.id
            AND legacy_parse.parser_version = $2::text
            AND legacy_parse.outcome = 'rejected'
            AND legacy_parse.reason_code = 'INVALID_CARRIER_TRACKING_PAYLOAD'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM wms.carrier_tracking_webhook_receipt_parses AS current_parse
          WHERE current_parse.carrier_tracking_webhook_receipt_id = receipt.id
            AND current_parse.parser_version = $3::text
        )
      ORDER BY receipt.id
      LIMIT $4::integer
    `, [
      afterReceiptId,
      LEGACY_PARSER_VERSION,
      CARRIER_TRACKING_PARSER_VERSION,
      QUERY_PAGE_SIZE,
    ]);

    if (result.rows.length === 0) break;
    for (const row of result.rows) {
      const receiptId = positiveInteger(row.id, "receipt.id");
      afterReceiptId = receiptId;
      preview.scannedRows += 1;
      try {
        const receipt = retainedReceipt(row);
        const rawPayload = decodeRetainedPayload(receipt);
        const event = normalizeShipStationTrackingWebhook(rawPayload, receipt.verifiedAt);
        if (flags.limit !== null && candidates.length >= flags.limit) break;
        candidates.push({
          receiptId,
          receipt,
          rawPayload,
          trackingNumber: event.trackingNumber,
          providerStatusCode: event.providerStatusCode,
          dispatchEvidence: event.dispatchEvidence,
        });
        if (preview.selectedSample.length < SAMPLE_LIMIT) {
          preview.selectedSample.push({
            receiptId,
            trackingSuffix: event.normalizedTrackingNumber.slice(-6),
            providerStatusCode: event.providerStatusCode,
            dispatchEvidence: event.dispatchEvidence,
          });
        }
      } catch (error) {
        const integrityFailure = !(error instanceof SyntaxError)
          && !isCarrierTrackingPayloadError(error);
        if (integrityFailure) preview.integrityFailures += 1;
        else preview.stillInvalid += 1;
        if (preview.excludedSample.length < SAMPLE_LIMIT) {
          preview.excludedSample.push({
            receiptId,
            classification: integrityFailure ? "integrity_failure" : "still_invalid",
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    if (result.rows.length < QUERY_PAGE_SIZE) break;
  }

  preview.selectedCount = candidates.length;
  return { preview, candidates };
}

export async function runReplay(
  flags: Flags,
  dependencies: {
    queryable: Queryable;
    service: ReplayService;
  },
): Promise<ReplayExecutionSummary> {
  const plan = await buildReplayPlan(dependencies.queryable, flags);
  const summary: ReplayExecutionSummary = {
    mode: flags.mode,
    preview: plan.preview,
    normalized: 0,
    eventsInserted: 0,
    parseAttemptsInserted: 0,
    alreadyProcessed: 0,
    failed: 0,
    failures: [],
  };
  if (flags.mode === "dry-run") return summary;
  if (flags.confirmCount !== plan.preview.selectedCount) {
    throw new Error(
      `--confirm-count=${flags.confirmCount} does not match selected dry-run count ${plan.preview.selectedCount}`,
    );
  }

  const context: CarrierTrackingWebhookReplayContext = {
    operator: flags.operator!,
    reason: flags.reason!,
    idempotencyKey: flags.idempotencyKey!,
  };
  for (const candidate of plan.candidates) {
    try {
      const result = await dependencies.service.replayVerifiedShipStationWebhook(
        candidate.rawPayload,
        candidate.receipt,
        context,
      );
      if (result.ingestStatus !== "normalized") {
        throw new Error(`Receipt remained rejected under ${CARRIER_TRACKING_PARSER_VERSION}: ${result.reasonCode}`);
      }
      summary.normalized += 1;
      if (result.eventInserted) summary.eventsInserted += 1;
      if (result.parseAttemptInserted) summary.parseAttemptsInserted += 1;
      if (!result.eventInserted && !result.parseAttemptInserted) summary.alreadyProcessed += 1;
    } catch (error) {
      summary.failed += 1;
      if (summary.failures.length < SAMPLE_LIMIT) {
        summary.failures.push({
          receiptId: candidate.receiptId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return summary;
}

function retainedReceipt(row: Record<string, unknown>): VerifiedCarrierWebhookReceipt {
  const provider = requiredText(row.provider, "provider");
  if (provider !== "shipstation") throw new Error(`Unsupported retained provider: ${provider}`);
  const signatureAlgorithm = requiredText(row.signature_algorithm, "signature_algorithm");
  if (signatureAlgorithm !== "RSA-SHA256" && signatureAlgorithm !== "HMAC-SHA256") {
    throw new Error(`Unsupported signature algorithm: ${signatureAlgorithm}`);
  }
  return {
    provider,
    receiptHash: requiredText(row.receipt_hash, "receipt_hash"),
    signatureAlgorithm,
    signatureKeyId: requiredText(row.signature_key_id, "signature_key_id"),
    signatureTimestampRaw: requiredText(row.signature_timestamp_raw, "signature_timestamp_raw"),
    signatureTimestampAt: requiredDate(row.signature_timestamp_at, "signature_timestamp_at"),
    rawBodyBase64: requiredText(row.raw_body_base64, "raw_body_base64"),
    rawBodyHash: requiredText(row.raw_body_hash, "raw_body_hash"),
    signatureBase64: requiredText(row.signature_base64, "signature_base64"),
    signatureHash: requiredText(row.signature_hash, "signature_hash"),
    verifiedAt: requiredDate(row.verified_at, "verified_at"),
  };
}

function decodeRetainedPayload(receipt: VerifiedCarrierWebhookReceipt): unknown {
  const rawBody = Buffer.from(receipt.rawBodyBase64, "base64");
  if (rawBody.length === 0) throw new Error("Retained webhook body is empty");
  const actualHash = createHash("sha256").update(rawBody).digest("hex");
  if (actualHash !== receipt.rawBodyHash.toLowerCase()) {
    throw new Error("Retained webhook body hash does not match its verified receipt");
  }
  return JSON.parse(rawBody.toString("utf8"));
}

function isCarrierTrackingPayloadError(error: unknown): boolean {
  return error instanceof Error && error.name === "CarrierTrackingPayloadError";
}

function limitFlag(argv: string[]): number | null {
  const raw = argv.find((arg) => arg.startsWith("--limit="));
  if (!raw) return DEFAULT_LIMIT;
  const value = raw.slice("--limit=".length);
  if (value === "all") return null;
  if (!/^\d+$/.test(value)) throw new Error(`--limit must be 1-${MAX_LIMIT} or all`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new Error(`--limit must be 1-${MAX_LIMIT} or all`);
  }
  return parsed;
}

function textFlag(argv: string[], prefix: string): string | null {
  const raw = argv.find((arg) => arg.startsWith(prefix));
  if (!raw) return null;
  const value = raw.slice(prefix.length).trim();
  if (!value || value.length > 500) {
    throw new Error(`${prefix.slice(0, -1)} must contain between 1 and 500 characters`);
  }
  return value;
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

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${field} in retained webhook receipt`);
  }
  return value.trim();
}

function requiredDate(value: unknown, field: string): Date {
  const parsed = value instanceof Date ? new Date(value) : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid ${field} in retained webhook receipt`);
  return parsed;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${field}`);
  return parsed;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }
  const [databaseModule, repositoryModule, serviceModule] = await Promise.all([
    import("../server/db"),
    import("../server/modules/shipping/carrier-tracking.repository"),
    import("../server/modules/shipping/carrier-tracking.service"),
  ]);
  const service = new serviceModule.CarrierTrackingService({
    repository: repositoryModule.createDrizzleCarrierTrackingRepository(databaseModule.db),
    clock: serviceModule.systemCarrierTrackingClock,
    logger: serviceModule.makeCarrierTrackingLogger(),
  }) as Pick<CarrierTrackingService, "replayVerifiedShipStationWebhook">;
  try {
    const result = await runReplay(flags, {
      queryable: databaseModule.pool,
      service,
    });
    if (flags.json) console.log(JSON.stringify(result));
    else console.log(`[Carrier tracking receipt replay] ${JSON.stringify(result, null, 2)}`);
  } finally {
    await databaseModule.pool.end();
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(`[Carrier tracking receipt replay] fatal: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}