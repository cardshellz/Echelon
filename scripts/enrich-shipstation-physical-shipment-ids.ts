/**
 * Enrich legacy WMS shipment rows with the stable ShipStation physical
 * shipment id.
 *
 * This script is intentionally conservative:
 * - dry-run by default
 * - fetches ShipStation by orderId, orderNumber, and trackingNumber because
 *   legacy rows can have stale or missing ShipStation order identity
 * - only accepts an exact one-to-one tracking-number match
 * - refuses to overwrite any existing external_fulfillment_id
 *
 * Usage:
 *   npx tsx scripts/enrich-shipstation-physical-shipment-ids.ts --dry-run --limit=25
 *   npx tsx scripts/enrich-shipstation-physical-shipment-ids.ts --execute --limit=all
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

type Mode = "dry-run" | "execute";

export interface Flags {
  help: boolean;
  mode: Mode;
  limit: number | null;
  concurrency: number;
  delayMs: number;
  requestTimeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  maxRateLimitErrors: number;
  progressEvery: number;
  orderNumber: string | null;
  wmsShipmentId: number | null;
  json: boolean;
}

interface CandidateRow {
  legacy_shipment_id: number;
  wms_order_id: number;
  order_number: string | null;
  legacy_shipment_status: string;
  shipping_engine: string | null;
  engine_order_ref: string | null;
  engine_shipment_ref: string | null;
  shipstation_order_id: number | null;
  shipstation_order_key: string | null;
  tracking_number: string;
  carrier: string | null;
  shipped_at: string | Date | null;
}

export interface ShipStationShipmentCandidate {
  shipmentId?: number | null;
  orderId?: number | null;
  orderKey?: string | null;
  orderNumber?: string | null;
  trackingNumber?: string | null;
  carrierCode?: string | null;
  shipDate?: string | null;
}

type MatchDecision =
  | {
      kind: "match";
      shipment: ShipStationShipmentCandidate;
      externalFulfillmentId: string;
      reason: string;
    }
  | {
      kind: "no_match" | "ambiguous" | "invalid_candidate" | "lookup_error";
      reason: string;
      matchingShipmentIds?: number[];
      providerStatus?: number | null;
    };

interface CandidateOutcome {
  candidate: CandidateRow;
  decision: MatchDecision;
  updated: boolean;
  updateSkippedReason: string | null;
}

interface ProcessedCandidate {
  outcome: CandidateOutcome;
  error: boolean;
  providerStatus: number | null;
}

export interface ShipStationRateLimitCircuit {
  rateLimitResponses: number;
  stoppedEarlyReason: string | null;
}

interface EnrichmentResult {
  runId: string;
  mode: Mode;
  candidates: number;
  matched: number;
  updated: number;
  noMatch: number;
  ambiguous: number;
  invalidCandidate: number;
  lookupErrors: number;
  updateSkipped: number;
  errors: number;
  rateLimitResponses: number;
  stoppedEarlyReason: string | null;
  outcomes: CandidateOutcome[];
}

const DEFAULT_LIMIT = 25;
const DEFAULT_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;
const DEFAULT_DELAY_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
const DEFAULT_MAX_RATE_LIMIT_ERRORS = 25;
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_PROGRESS_EVERY = 25;
const DEFAULT_BASE_URL = "https://ssapi.shipstation.com";
export const NOT_FOUND_REVIEW_REASON = "physical_identity_not_found_after_enrichment";

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/enrich-shipstation-physical-shipment-ids.ts --dry-run --limit=25",
    "  npx tsx scripts/enrich-shipstation-physical-shipment-ids.ts --execute --limit=all",
    "  npx tsx scripts/enrich-shipstation-physical-shipment-ids.ts --order-number=#59453",
    "",
    "Flags:",
    "  --dry-run              Fetch and classify only. Default.",
    "  --execute              Persist exact one-to-one matches.",
    "  --limit=N|all          Max WMS shipment rows to inspect. Default 25.",
    "  --concurrency=N        Number of rows to process in parallel. Default 1, max 8.",
    "  --delay-ms=N           Delay between ShipStation lookups. Default 250.",
    "  --request-timeout-ms=N Abort each ShipStation HTTP request after N ms. Default 20000.",
    "  --max-retries=N        Retry transient ShipStation lookup failures N times. Default 3.",
    "  --retry-base-delay-ms=N Base exponential retry delay. Default 2000, max delay 60000.",
    "  --max-rate-limit-errors=N Stop after N ShipStation 429 responses during the run. Default 25; 0 disables.",
    "  --progress-every=N     Print aggregate progress every N rows. Use 0 to disable. Default 25.",
    "  --order-number=TEXT    Restrict to one WMS order number.",
    "  --wms-shipment-id=N    Restrict to one WMS outbound shipment id.",
    "  --json                 Print machine-readable JSON summary.",
  ].join("\n");
}

export function parseFlags(argv: string[]): Flags {
  const help = argv.includes("--help") || argv.includes("-h");
  const dryRun = argv.includes("--dry-run");
  const execute = argv.includes("--execute");
  const json = argv.includes("--json");

  if (dryRun && execute) {
    throw new Error("Cannot pass both --execute and --dry-run");
  }

  const knownFlag = /^(--help|-h|--dry-run|--execute|--limit=|--concurrency=|--delay-ms=|--request-timeout-ms=|--max-retries=|--retry-base-delay-ms=|--max-rate-limit-errors=|--progress-every=|--order-number=|--wms-shipment-id=|--json$)/;
  const unknown = argv.find((arg) => !knownFlag.test(arg));
  if (unknown) {
    throw new Error(`Unknown flag: ${unknown}`);
  }

  const limit = parseOptionalPositiveIntegerFlag(argv, "--limit=", DEFAULT_LIMIT, true);
  const concurrency = parseOptionalBoundedPositiveIntegerFlag(
    argv,
    "--concurrency=",
    DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
  );
  const delayMs = parseOptionalNonnegativeIntegerFlag(argv, "--delay-ms=", DEFAULT_DELAY_MS);
  const requestTimeoutMs = parseOptionalPositiveIntegerFlag(
    argv,
    "--request-timeout-ms=",
    DEFAULT_REQUEST_TIMEOUT_MS,
    false,
  );
  if (requestTimeoutMs == null) {
    throw new Error("--request-timeout-ms must be a positive integer");
  }
  const maxRetries = parseOptionalNonnegativeIntegerFlag(argv, "--max-retries=", DEFAULT_MAX_RETRIES);
  const retryBaseDelayMs = parseOptionalNonnegativeIntegerFlag(
    argv,
    "--retry-base-delay-ms=",
    DEFAULT_RETRY_BASE_DELAY_MS,
  );
  const maxRateLimitErrors = parseOptionalNonnegativeIntegerFlag(
    argv,
    "--max-rate-limit-errors=",
    DEFAULT_MAX_RATE_LIMIT_ERRORS,
  );
  const progressEvery = parseOptionalNonnegativeIntegerFlag(argv, "--progress-every=", DEFAULT_PROGRESS_EVERY);
  const orderNumberArg = argv.find((arg) => arg.startsWith("--order-number="));
  const orderNumber = orderNumberArg == null ? null : orderNumberArg.slice("--order-number=".length).trim();
  if (orderNumber !== null && orderNumber.length === 0) {
    throw new Error("--order-number cannot be blank");
  }

  const wmsShipmentId = parseOptionalPositiveIntegerFlag(argv, "--wms-shipment-id=", null, false);

  return {
    help,
    mode: execute ? "execute" : "dry-run",
    limit,
    concurrency,
    delayMs,
    requestTimeoutMs,
    maxRetries,
    retryBaseDelayMs,
    maxRateLimitErrors,
    progressEvery,
    orderNumber,
    wmsShipmentId,
    json,
  };
}

function parseOptionalPositiveIntegerFlag(
  argv: string[],
  prefix: string,
  defaultValue: number | null,
  allowAll: boolean,
): number | null {
  const arg = argv.find((value) => value.startsWith(prefix));
  if (arg == null) return defaultValue;
  const raw = arg.slice(prefix.length).trim().toLowerCase();
  if (allowAll && raw === "all") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${prefix.slice(0, -1)} must be a positive integer${allowAll ? " or all" : ""}`);
  }
  return parsed;
}

function parseOptionalBoundedPositiveIntegerFlag(
  argv: string[],
  prefix: string,
  defaultValue: number,
  maxValue: number,
): number {
  const arg = argv.find((value) => value.startsWith(prefix));
  if (arg == null) return defaultValue;
  const raw = arg.slice(prefix.length).trim();
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maxValue) {
    throw new Error(`${prefix.slice(0, -1)} must be a positive integer no greater than ${maxValue}`);
  }
  return parsed;
}

function parseOptionalNonnegativeIntegerFlag(argv: string[], prefix: string, defaultValue: number): number {
  const arg = argv.find((value) => value.startsWith(prefix));
  if (arg == null) return defaultValue;
  const raw = arg.slice(prefix.length).trim();
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${prefix.slice(0, -1)} must be a non-negative integer`);
  }
  return parsed;
}

export function shipStationShipmentExternalFulfillmentId(shipmentId: number): string | null {
  if (!Number.isInteger(shipmentId) || shipmentId <= 0) return null;
  return `shipstation_shipment:${shipmentId}`;
}

function normalizeTrackingNumber(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.toUpperCase();
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function buildShipStationShipmentsPath(params: {
  orderId?: number | null;
  orderNumber?: string | null;
  trackingNumber?: string | null;
}): string {
  const search = new URLSearchParams();
  if (params.orderId != null) search.set("orderId", String(params.orderId));
  if (params.orderNumber != null && params.orderNumber.trim().length > 0) {
    search.set("orderNumber", params.orderNumber.trim());
  }
  if (params.trackingNumber != null && params.trackingNumber.trim().length > 0) {
    search.set("trackingNumber", params.trackingNumber.trim());
  }
  search.set("includeShipmentItems", "true");
  return `/shipments?${search.toString()}`;
}

export function buildShipStationShipmentsUrl(
  baseUrl: string,
  params: { orderId?: number | null; orderNumber?: string | null; trackingNumber?: string | null },
): string {
  return `${normalizeBaseUrl(baseUrl)}${buildShipStationShipmentsPath(params)}`;
}

export function mergeShipStationShipments(
  shipments: ShipStationShipmentCandidate[],
): ShipStationShipmentCandidate[] {
  const merged = new Map<number, ShipStationShipmentCandidate>();
  const noId: ShipStationShipmentCandidate[] = [];

  for (const shipment of shipments) {
    const shipmentId = Number(shipment.shipmentId);
    if (Number.isInteger(shipmentId) && shipmentId > 0) {
      merged.set(shipmentId, shipment);
    } else {
      noId.push(shipment);
    }
  }

  return [...merged.values(), ...noId];
}

export function decideShipStationPhysicalMatch(
  candidate: { tracking_number?: string | null; shipstation_order_id?: number | null },
  shipments: ShipStationShipmentCandidate[],
): MatchDecision {
  const tracking = normalizeTrackingNumber(candidate.tracking_number);
  if (tracking === null) {
    return { kind: "invalid_candidate", reason: "candidate shipment has no tracking number" };
  }

  const matches = shipments.filter((shipment) => normalizeTrackingNumber(shipment.trackingNumber) === tracking);
  if (matches.length === 0) {
    return { kind: "no_match", reason: "no ShipStation shipment has the WMS tracking number" };
  }

  const shipmentIds = matches
    .map((shipment) => Number(shipment.shipmentId))
    .filter((shipmentId) => Number.isInteger(shipmentId) && shipmentId > 0);
  const uniqueShipmentIds = [...new Set(shipmentIds)];

  if (matches.length === 1 && uniqueShipmentIds.length !== 1) {
    return {
      kind: "invalid_candidate",
      reason: "matching ShipStation shipment has no positive integer shipmentId",
    };
  }

  if (matches.length !== 1 || uniqueShipmentIds.length !== 1) {
    return {
      kind: "ambiguous",
      reason: "multiple ShipStation shipments share the WMS tracking number",
      matchingShipmentIds: uniqueShipmentIds,
    };
  }

  const externalFulfillmentId = shipStationShipmentExternalFulfillmentId(uniqueShipmentIds[0]);
  if (externalFulfillmentId === null) {
    return {
      kind: "invalid_candidate",
      reason: "matching ShipStation shipment has no positive integer shipmentId",
    };
  }

  return {
    kind: "match",
    shipment: matches[0],
    externalFulfillmentId,
    reason: "exact one-to-one tracking-number match",
  };
}

export function buildCandidateSql(flags: Pick<Flags, "limit" | "orderNumber" | "wmsShipmentId">): {
  sql: string;
  params: unknown[];
} {
  const where: string[] = [
    "s.status::text = 'shipped'",
    "NULLIF(BTRIM(COALESCE(s.tracking_number, '')), '') IS NOT NULL",
    "NULLIF(BTRIM(COALESCE(s.external_fulfillment_id, '')), '') IS NULL",
    "COALESCE(NULLIF(BTRIM(s.shipping_engine), ''), 'shipstation') = 'shipstation'",
  ];
  const params: unknown[] = [];

  if (flags.orderNumber !== null) {
    params.push(flags.orderNumber);
    where.push(`o.order_number = $${params.length}`);
  }
  if (flags.wmsShipmentId !== null) {
    params.push(flags.wmsShipmentId);
    where.push(`s.id = $${params.length}`);
  }

  const limitClause = flags.limit === null ? "" : `LIMIT ${flags.limit}`;
  return {
    sql: `
      SELECT
        s.id AS legacy_shipment_id,
        s.order_id AS wms_order_id,
        o.order_number,
        s.status::text AS legacy_shipment_status,
        s.shipping_engine,
        s.engine_order_ref,
        s.engine_shipment_ref,
        s.shipstation_order_id,
        s.shipstation_order_key,
        s.tracking_number,
        s.carrier,
        s.shipped_at
      FROM wms.outbound_shipments s
      JOIN wms.orders o ON o.id = s.order_id
      WHERE ${where.join("\n        AND ")}
      ORDER BY s.shipped_at DESC NULLS LAST, s.id DESC
      ${limitClause}
    `,
    params,
  };
}

function loadDotenvIfAvailable(): void {
  if (process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL) return;
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const env = fs.readFileSync(envPath, "utf8").replace(/\0/g, "");
  for (const line of env.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsAt = trimmed.indexOf("=");
    if (equalsAt <= 0) continue;
    const key = trimmed.slice(0, equalsAt);
    if (process.env[key]) continue;
    let value = trimmed.slice(equalsAt + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function connectionStringFromEnv(): string {
  loadDotenvIfAvailable();
  const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("EXTERNAL_DATABASE_URL or DATABASE_URL is required");
  }
  return connectionString;
}

function shipStationAuthHeaderFromEnv(): string {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  const apiSecret = process.env.SHIPSTATION_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("SHIPSTATION_API_KEY and SHIPSTATION_API_SECRET must be set");
  }
  return `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
}

export class ShipStationHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly bodySnippet: string;
  readonly retryAfterMs: number | null;

  constructor(params: {
    url: string;
    status: number;
    bodySnippet: string;
    retryAfterMs: number | null;
  }) {
    super(`ShipStation GET ${params.url} failed ${params.status}: ${params.bodySnippet}`);
    this.name = "ShipStationHttpError";
    this.url = params.url;
    this.status = params.status;
    this.bodySnippet = params.bodySnippet;
    this.retryAfterMs = params.retryAfterMs;
  }
}

export class ShipStationTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`ShipStation GET ${url} timed out after ${timeoutMs}ms`);
    this.name = "ShipStationTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

export class ShipStationRateLimitCircuitOpenError extends Error {
  readonly providerStatus = 429;

  constructor(reason: string) {
    super(reason);
    this.name = "ShipStationRateLimitCircuitOpenError";
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export function isPostgresUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

export function parseRetryAfterHeader(value: string | null, nowMs = Date.now()): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const retryAtMs = Date.parse(trimmed);
  if (Number.isNaN(retryAtMs)) return null;
  return Math.max(0, retryAtMs - nowMs);
}

function isRetryableShipStationLookupError(err: unknown): boolean {
  if (err instanceof ShipStationTimeoutError) return true;
  if (err instanceof ShipStationHttpError) {
    return err.status === 429 || err.status >= 500;
  }
  return err instanceof TypeError;
}

function providerStatusFromError(err: unknown): number | null {
  if (err instanceof ShipStationRateLimitCircuitOpenError) return err.providerStatus;
  return err instanceof ShipStationHttpError ? err.status : null;
}

function isShipStationRateLimitError(err: unknown): boolean {
  return err instanceof ShipStationHttpError && err.status === 429;
}

export function createShipStationRateLimitCircuit(): ShipStationRateLimitCircuit {
  return {
    rateLimitResponses: 0,
    stoppedEarlyReason: null,
  };
}

export function recordShipStationRateLimitResponse(
  circuit: ShipStationRateLimitCircuit,
  maxRateLimitErrors: number,
): string | null {
  circuit.rateLimitResponses += 1;
  if (
    circuit.stoppedEarlyReason === null &&
    maxRateLimitErrors > 0 &&
    circuit.rateLimitResponses >= maxRateLimitErrors
  ) {
    circuit.stoppedEarlyReason =
      `stopped after ${circuit.rateLimitResponses} ShipStation 429 responses during this run`;
  }
  return circuit.stoppedEarlyReason;
}

function retryDelayMs(err: unknown, retryIndex: number, baseDelayMs: number): number {
  if (err instanceof ShipStationHttpError && err.retryAfterMs !== null) {
    return Math.min(err.retryAfterMs, MAX_RETRY_DELAY_MS);
  }
  return Math.min(baseDelayMs * (2 ** retryIndex), MAX_RETRY_DELAY_MS);
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function fetchShipStationJsonWithTimeout<T>(
  url: string,
  authHeader: string,
  requestTimeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ShipStationHttpError({
        url,
        status: res.status,
        bodySnippet: text.slice(0, 500),
        retryAfterMs: parseRetryAfterHeader(res.headers.get("retry-after")),
      });
    }
    return await res.json() as T;
  } catch (err) {
    if (isAbortError(err)) {
      throw new ShipStationTimeoutError(url, requestTimeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchShipStationJsonWithRetries<T>(
  url: string,
  authHeader: string,
  flags: Pick<Flags, "requestTimeoutMs" | "maxRetries" | "retryBaseDelayMs" | "maxRateLimitErrors" | "json">,
  rateLimitCircuit: ShipStationRateLimitCircuit,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    if (rateLimitCircuit.stoppedEarlyReason !== null) {
      throw new ShipStationRateLimitCircuitOpenError(rateLimitCircuit.stoppedEarlyReason);
    }

    try {
      return await fetchShipStationJsonWithTimeout<T>(url, authHeader, flags.requestTimeoutMs);
    } catch (err) {
      if (isShipStationRateLimitError(err)) {
        const stopReason = recordShipStationRateLimitResponse(rateLimitCircuit, flags.maxRateLimitErrors);
        if (stopReason !== null) {
          throw new ShipStationRateLimitCircuitOpenError(stopReason);
        }
      }

      if (attempt >= flags.maxRetries || !isRetryableShipStationLookupError(err)) {
        throw err;
      }

      const waitMs = retryDelayMs(err, attempt, flags.retryBaseDelayMs);
      if (!flags.json) {
        console.warn(
          `[ShipStation physical id enrich] RETRY attempt=${attempt + 1}/${flags.maxRetries} ` +
          `waitMs=${waitMs} reason="${errorReason(err)}"`,
        );
      }
      await sleep(waitMs);
    }
  }
}

async function fetchShipStationShipmentsByOrder(
  candidate: CandidateRow,
  authHeader: string,
  flags: Pick<Flags, "requestTimeoutMs" | "maxRetries" | "retryBaseDelayMs" | "maxRateLimitErrors" | "json">,
  rateLimitCircuit: ShipStationRateLimitCircuit,
): Promise<ShipStationShipmentCandidate[]> {
  const baseUrl = process.env.SHIPSTATION_API_BASE_URL || DEFAULT_BASE_URL;
  const urls: string[] = [];
  if (candidate.shipstation_order_id !== null) {
    urls.push(buildShipStationShipmentsUrl(baseUrl, { orderId: candidate.shipstation_order_id }));
  }
  if (candidate.order_number) {
    urls.push(buildShipStationShipmentsUrl(baseUrl, { orderNumber: candidate.order_number }));
  }
  urls.push(buildShipStationShipmentsUrl(baseUrl, { trackingNumber: candidate.tracking_number }));

  const shipments: ShipStationShipmentCandidate[] = [];
  for (const url of [...new Set(urls)]) {
    const body = await fetchShipStationJsonWithRetries<{ shipments?: ShipStationShipmentCandidate[] }>(
      url,
      authHeader,
      flags,
      rateLimitCircuit,
    );
    shipments.push(...(Array.isArray(body.shipments) ? body.shipments : []));
  }

  return mergeShipStationShipments(shipments);
}

async function fetchCandidates(pool: Pool, flags: Flags): Promise<CandidateRow[]> {
  const query = buildCandidateSql(flags);
  const result = await pool.query(query.sql, query.params);
  return result.rows as CandidateRow[];
}

async function hasExternalFulfillmentConflict(
  client: PoolClient,
  shipmentId: number,
  externalFulfillmentId: string,
): Promise<boolean> {
  const result = await client.query(
    `
      SELECT id
      FROM wms.outbound_shipments
      WHERE external_fulfillment_id = $1
        AND id <> $2
      LIMIT 1
    `,
    [externalFulfillmentId, shipmentId],
  );
  return result.rowCount > 0;
}

export function applyExternalFulfillmentIdSql(): string {
  return `
      UPDATE wms.outbound_shipments
      SET external_fulfillment_id = $1,
          requires_review = CASE
            WHEN review_reason = $5 THEN false
            ELSE requires_review
          END,
          review_reason = CASE
            WHEN review_reason = $5 THEN NULL
            ELSE review_reason
          END,
          updated_at = NOW()
      WHERE id = $2
        AND status::text = 'shipped'
        AND shipstation_order_id IS NOT DISTINCT FROM $3::bigint
        AND tracking_number = $4
        AND NULLIF(BTRIM(COALESCE(external_fulfillment_id, '')), '') IS NULL
      RETURNING id
    `;
}

async function applyExternalFulfillmentId(
  client: PoolClient,
  candidate: CandidateRow,
  externalFulfillmentId: string,
): Promise<{ updated: boolean; skippedReason: string | null }> {
  if (await hasExternalFulfillmentConflict(client, candidate.legacy_shipment_id, externalFulfillmentId)) {
    return { updated: false, skippedReason: "external fulfillment id already belongs to another shipment" };
  }

  const result = await client.query(
    applyExternalFulfillmentIdSql(),
    [
      externalFulfillmentId,
      candidate.legacy_shipment_id,
      candidate.shipstation_order_id,
      candidate.tracking_number,
      NOT_FOUND_REVIEW_REASON,
    ],
  );

  return {
    updated: result.rowCount === 1,
    skippedReason: result.rowCount === 1 ? null : "guarded update matched no rows",
  };
}

function printOutcome(outcome: CandidateOutcome, mode: Mode): void {
  const c = outcome.candidate;
  if (outcome.decision.kind === "match") {
    const action = mode === "execute"
      ? outcome.updated ? "UPDATE" : "SKIP_UPDATE"
      : "PLAN";
    console.log(
      `[ShipStation physical id enrich] ${action} wms=${c.legacy_shipment_id} order=${c.order_number ?? "unknown"} ` +
      `ssOrder=${c.shipstation_order_id ?? "unknown"} tracking=${c.tracking_number} -> ${outcome.decision.externalFulfillmentId}` +
      `${outcome.updateSkippedReason ? ` reason="${outcome.updateSkippedReason}"` : ""}`,
    );
    return;
  }

  console.log(
    `[ShipStation physical id enrich] ${outcome.decision.kind.toUpperCase()} wms=${c.legacy_shipment_id} ` +
    `order=${c.order_number ?? "unknown"} ssOrder=${c.shipstation_order_id ?? "unknown"} tracking=${c.tracking_number} ` +
    `${outcome.decision.providerStatus != null ? `status=${outcome.decision.providerStatus} ` : ""}` +
    `reason="${outcome.decision.reason}"`,
  );
}

function summarizeOutcomes(
  runId: string,
  mode: Mode,
  outcomes: CandidateOutcome[],
  errors: number,
  rateLimitResponses: number,
  stoppedEarlyReason: string | null = null,
): EnrichmentResult {
  return {
    runId,
    mode,
    candidates: outcomes.length,
    matched: outcomes.filter((outcome) => outcome.decision.kind === "match").length,
    updated: outcomes.filter((outcome) => outcome.updated).length,
    noMatch: outcomes.filter((outcome) => outcome.decision.kind === "no_match").length,
    ambiguous: outcomes.filter((outcome) => outcome.decision.kind === "ambiguous").length,
    invalidCandidate: outcomes.filter((outcome) => outcome.decision.kind === "invalid_candidate").length,
    lookupErrors: outcomes.filter((outcome) => outcome.decision.kind === "lookup_error").length,
    updateSkipped: outcomes.filter((outcome) => outcome.updateSkippedReason !== null).length,
    errors,
    rateLimitResponses,
    stoppedEarlyReason,
    outcomes,
  };
}

async function enrichCandidate(
  pool: Pool,
  candidate: CandidateRow,
  authHeader: string,
  flags: Flags,
  rateLimitCircuit: ShipStationRateLimitCircuit,
): Promise<ProcessedCandidate> {
  try {
    const shipments = await fetchShipStationShipmentsByOrder(candidate, authHeader, flags, rateLimitCircuit);
    const decision = decideShipStationPhysicalMatch(candidate, shipments);
    let updated = false;
    let updateSkippedReason: string | null = null;

    if (flags.mode === "execute" && decision.kind === "match") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const update = await applyExternalFulfillmentId(client, candidate, decision.externalFulfillmentId);
        updated = update.updated;
        updateSkippedReason = update.skippedReason;
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (isPostgresUniqueViolation(err)) {
          updateSkippedReason = "external fulfillment id already belongs to another shipment";
        } else {
          throw err;
        }
      } finally {
        client.release();
      }
    }

    return {
      outcome: { candidate, decision, updated, updateSkippedReason },
      error: false,
      providerStatus: null,
    };
  } catch (err) {
    const providerStatus = providerStatusFromError(err);
    return {
      outcome: {
        candidate,
        decision: {
          kind: "lookup_error",
          reason: errorReason(err),
          providerStatus,
        },
        updated: false,
        updateSkippedReason: "lookup failed",
      },
      error: true,
      providerStatus,
    };
  }
}

function printCandidateLookup(index: number, total: number, candidate: CandidateRow): void {
  console.log(
    `[ShipStation physical id enrich] LOOKUP ${index}/${total} wms=${candidate.legacy_shipment_id} ` +
    `order=${candidate.order_number ?? "unknown"} ssOrder=${candidate.shipstation_order_id ?? "unknown"} ` +
    `tracking=${candidate.tracking_number}`,
  );
}

function shouldPrintProgress(progressEvery: number, processed: number, total: number): boolean {
  return progressEvery > 0 && (processed % progressEvery === 0 || processed === total);
}

function printProgress(
  runId: string,
  mode: Mode,
  outcomes: CandidateOutcome[],
  errors: number,
  rateLimitResponses: number,
  total: number,
  startedAtMs: number,
): void {
  const summary = summarizeOutcomes(runId, mode, outcomes, errors, rateLimitResponses);
  console.log(
    `[ShipStation physical id enrich] PROGRESS ${JSON.stringify({
      runId,
      processed: summary.candidates,
      total,
      matched: summary.matched,
      updated: summary.updated,
      noMatch: summary.noMatch,
      ambiguous: summary.ambiguous,
      invalidCandidate: summary.invalidCandidate,
      lookupErrors: summary.lookupErrors,
      rateLimitResponses: summary.rateLimitResponses,
      updateSkipped: summary.updateSkipped,
      errors: summary.errors,
      elapsedMs: Date.now() - startedAtMs,
    })}`,
  );
}

function sleep(delayMs: number): Promise<void> {
  return delayMs <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function runEnrichment(flags: Flags): Promise<EnrichmentResult> {
  const connectionString = connectionStringFromEnv();
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });
  const authHeader = shipStationAuthHeaderFromEnv();
  const runId = crypto.randomUUID();
  const outcomes: CandidateOutcome[] = [];
  let errors = 0;
  const startedAtMs = Date.now();
  const rateLimitCircuit = createShipStationRateLimitCircuit();

  try {
    const candidates = await fetchCandidates(pool, flags);
    const outcomesByIndex = new Array<CandidateOutcome | undefined>(candidates.length);
    let nextIndex = 0;
    let processed = 0;

    const workerCount = Math.min(flags.concurrency, candidates.length);
    const worker = async (): Promise<void> => {
      while (true) {
        if (rateLimitCircuit.stoppedEarlyReason !== null) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= candidates.length) return;

        const candidate = candidates[index];
        if (!flags.json) {
          printCandidateLookup(index + 1, candidates.length, candidate);
        }

        const processedCandidate = await enrichCandidate(pool, candidate, authHeader, flags, rateLimitCircuit);
        outcomesByIndex[index] = processedCandidate.outcome;
        if (processedCandidate.error) errors += 1;
        outcomes.push(processedCandidate.outcome);
        processed += 1;

        if (!flags.json) printOutcome(processedCandidate.outcome, flags.mode);
        if (!flags.json && shouldPrintProgress(flags.progressEvery, processed, candidates.length)) {
          printProgress(
            runId,
            flags.mode,
            outcomes,
            errors,
            rateLimitCircuit.rateLimitResponses,
            candidates.length,
            startedAtMs,
          );
        }

        if (rateLimitCircuit.stoppedEarlyReason !== null) {
          if (!flags.json) {
            console.error(`[ShipStation physical id enrich] STOP ${rateLimitCircuit.stoppedEarlyReason}`);
          }
          return;
        }

        if (flags.delayMs > 0 && processed < candidates.length) {
          await sleep(flags.delayMs);
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    const orderedOutcomes = outcomesByIndex.filter((outcome): outcome is CandidateOutcome => outcome !== undefined);
    return summarizeOutcomes(
      runId,
      flags.mode,
      orderedOutcomes,
      errors,
      rateLimitCircuit.rateLimitResponses,
      rateLimitCircuit.stoppedEarlyReason,
    );
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  if (!flags.json) {
    console.log(
      `[ShipStation physical id enrich] mode=${flags.mode} limit=${flags.limit ?? "all"} ` +
      `concurrency=${flags.concurrency} delayMs=${flags.delayMs}` +
      ` requestTimeoutMs=${flags.requestTimeoutMs} maxRetries=${flags.maxRetries}` +
      ` retryBaseDelayMs=${flags.retryBaseDelayMs} maxRateLimitErrors=${flags.maxRateLimitErrors}` +
      ` progressEvery=${flags.progressEvery}` +
      `${flags.orderNumber ? ` orderNumber=${flags.orderNumber}` : ""}` +
      `${flags.wmsShipmentId ? ` wmsShipmentId=${flags.wmsShipmentId}` : ""}`,
    );
  }

  const result = await runEnrichment(flags);
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `[ShipStation physical id enrich] complete ${JSON.stringify({
        runId: result.runId,
        candidates: result.candidates,
        matched: result.matched,
        updated: result.updated,
        noMatch: result.noMatch,
        ambiguous: result.ambiguous,
        invalidCandidate: result.invalidCandidate,
        lookupErrors: result.lookupErrors,
        rateLimitResponses: result.rateLimitResponses,
        updateSkipped: result.updateSkipped,
        errors: result.errors,
        stoppedEarlyReason: result.stoppedEarlyReason,
      })}`,
    );
  }

  if (result.errors > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[ShipStation physical id enrich] fatal:", err);
    process.exit(1);
  });
}
