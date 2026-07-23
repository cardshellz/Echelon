/**
 * Enrich legacy WMS shipment rows with stable ShipStation identity.
 *
 * This script is intentionally conservative:
 * - dry-run by default
 * - fetches ShipStation by orderId, orderNumber, and trackingNumber because
 *   legacy rows can have stale or missing ShipStation order identity
 * - only accepts an exact one-to-one tracking-number match
 * - refuses to overwrite any existing conflicting identity
 * - keeps physical-id enrichment as the default scope
 * - requires an explicit scope to repair missing provider-order linkage
 *
 * Usage:
 *   npx tsx scripts/enrich-shipstation-physical-shipment-ids.ts --dry-run --limit=25
 *   npx tsx scripts/enrich-shipstation-physical-shipment-ids.ts --execute --limit=all
 *   npx tsx scripts/enrich-shipstation-physical-shipment-ids.ts --dry-run --scope=provider-order-linkage --limit=all
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

type Mode = "dry-run" | "execute";
export type EnrichmentScope = "physical-id" | "provider-order-linkage";

export interface Flags {
  help: boolean;
  mode: Mode;
  scope: EnrichmentScope;
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
  operator: string;
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
  external_fulfillment_id: string | null;
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

export interface ShipStationProviderOrderLinkage {
  shippingEngine: "shipstation";
  engineOrderRef: string;
  engineShipmentRef: string;
  shipstationOrderId: number;
  shipstationOrderKey: string;
}

type MatchDecision =
  | {
      kind: "match";
      shipment: ShipStationShipmentCandidate;
      externalFulfillmentId: string;
      providerOrderLinkage?: ShipStationProviderOrderLinkage;
      reason: string;
    }
  | {
      kind: "no_match" | "ambiguous" | "invalid_candidate" | "identity_conflict" | "lookup_error";
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
  scope: EnrichmentScope;
  candidates: number;
  matched: number;
  updated: number;
  noMatch: number;
  ambiguous: number;
  invalidCandidate: number;
  identityConflicts: number;
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
const DEFAULT_OPERATOR = "script:enrich-shipstation-identity";
export const NOT_FOUND_REVIEW_REASON = "physical_identity_not_found_after_enrichment";

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/enrich-shipstation-physical-shipment-ids.ts --dry-run --limit=25",
    "  npx tsx scripts/enrich-shipstation-physical-shipment-ids.ts --execute --limit=all",
    "  npx tsx scripts/enrich-shipstation-physical-shipment-ids.ts --order-number=#59453",
    "  npx tsx scripts/enrich-shipstation-physical-shipment-ids.ts --dry-run --scope=provider-order-linkage --limit=all",
    "",
    "Flags:",
    "  --dry-run              Fetch and classify only. Default.",
    "  --execute              Persist exact one-to-one matches.",
    "  --scope=VALUE          physical-id (default) or provider-order-linkage.",
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
    `  --operator=IDENTITY     Audit actor for provider-order repairs. Default ${DEFAULT_OPERATOR}.`,
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

  const knownFlag = /^(--help|-h|--dry-run|--execute|--scope=|--limit=|--concurrency=|--delay-ms=|--request-timeout-ms=|--max-retries=|--retry-base-delay-ms=|--max-rate-limit-errors=|--progress-every=|--order-number=|--wms-shipment-id=|--operator=|--json$)/;
  const unknown = argv.find((arg) => !knownFlag.test(arg));
  if (unknown) {
    throw new Error(`Unknown flag: ${unknown}`);
  }

  const limit = parseOptionalPositiveIntegerFlag(argv, "--limit=", DEFAULT_LIMIT, true);
  const scopeArg = argv.find((arg) => arg.startsWith("--scope="));
  const scopeValue = scopeArg?.slice("--scope=".length).trim() || "physical-id";
  if (scopeValue !== "physical-id" && scopeValue !== "provider-order-linkage") {
    throw new Error("--scope must be physical-id or provider-order-linkage");
  }
  const scope: EnrichmentScope = scopeValue;
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
  const operatorArg = argv.find((arg) => arg.startsWith("--operator="));
  const operator = operatorArg == null
    ? DEFAULT_OPERATOR
    : operatorArg.slice("--operator=".length).trim();
  if (operator.length === 0) {
    throw new Error("--operator cannot be blank");
  }
  if (operator.length > 120) {
    throw new Error("--operator cannot exceed 120 characters");
  }

  return {
    help,
    mode: execute ? "execute" : "dry-run",
    scope,
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
    operator,
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

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function parsePersistedShipStationPhysicalShipmentId(value: unknown): number | null {
  const normalized = normalizeOptionalString(value);
  if (normalized === null) return null;

  const match = /^(?:shipstation_shipment:|shipstation_combined:|provider_physical:v1:shipstation:)(\d+)/
    .exec(normalized);
  if (match === null) return null;

  if (
    !/^shipstation_shipment:\d+$/.test(normalized)
    && !/^shipstation_combined:\d+:order:\d+$/.test(normalized)
    && !/^provider_physical:v1:shipstation:\d+$/.test(normalized)
  ) {
    return null;
  }

  const shipmentId = Number(match[1]);
  return Number.isSafeInteger(shipmentId) && shipmentId > 0 ? shipmentId : null;
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

export function decideShipStationProviderOrderLinkage(
  candidate: {
    external_fulfillment_id?: string | null;
    shipping_engine?: string | null;
    engine_order_ref?: string | null;
    engine_shipment_ref?: string | null;
    shipstation_order_id?: number | null;
    shipstation_order_key?: string | null;
  },
  physicalDecision: MatchDecision,
): MatchDecision {
  if (physicalDecision.kind !== "match") return physicalDecision;

  const expectedPhysicalShipmentId = parsePersistedShipStationPhysicalShipmentId(
    candidate.external_fulfillment_id,
  );
  if (expectedPhysicalShipmentId === null) {
    return {
      kind: "invalid_candidate",
      reason: "candidate has no valid persisted ShipStation physical shipment identity",
    };
  }

  const actualPhysicalShipmentId = Number(physicalDecision.shipment.shipmentId);
  if (
    !Number.isSafeInteger(actualPhysicalShipmentId)
    || actualPhysicalShipmentId <= 0
    || actualPhysicalShipmentId !== expectedPhysicalShipmentId
  ) {
    return {
      kind: "identity_conflict",
      reason:
        `persisted physical shipment ${expectedPhysicalShipmentId} does not match `
        + `ShipStation shipment ${String(physicalDecision.shipment.shipmentId)}`,
    };
  }

  const shipstationOrderId = Number(physicalDecision.shipment.orderId);
  if (!Number.isSafeInteger(shipstationOrderId) || shipstationOrderId <= 0) {
    return {
      kind: "invalid_candidate",
      reason: "matching ShipStation shipment has no positive integer orderId",
    };
  }

  const shipstationOrderKey = normalizeOptionalString(physicalDecision.shipment.orderKey);
  if (shipstationOrderKey === null) {
    return {
      kind: "invalid_candidate",
      reason: "matching ShipStation shipment has no orderKey",
    };
  }
  if (shipstationOrderKey.length > 100) {
    return {
      kind: "invalid_candidate",
      reason: "matching ShipStation orderKey exceeds the 100-character legacy persistence limit",
    };
  }

  const expectedOrderRef = String(shipstationOrderId);
  const existingShippingEngine = normalizeOptionalString(candidate.shipping_engine)?.toLowerCase() ?? null;
  const existingEngineOrderRef = normalizeOptionalString(candidate.engine_order_ref);
  const existingEngineShipmentRef = normalizeOptionalString(candidate.engine_shipment_ref);
  const existingShipstationOrderKey = normalizeOptionalString(candidate.shipstation_order_key);
  const existingShipstationOrderId = candidate.shipstation_order_id == null
    ? null
    : Number(candidate.shipstation_order_id);

  const conflicts: string[] = [];
  if (existingShippingEngine !== null && existingShippingEngine !== "shipstation") {
    conflicts.push(`shipping_engine=${existingShippingEngine}`);
  }
  if (existingEngineOrderRef !== null && existingEngineOrderRef !== expectedOrderRef) {
    conflicts.push(`engine_order_ref=${existingEngineOrderRef}`);
  }
  if (existingEngineShipmentRef !== null && existingEngineShipmentRef !== shipstationOrderKey) {
    conflicts.push(`engine_shipment_ref=${existingEngineShipmentRef}`);
  }
  if (existingShipstationOrderId !== null && existingShipstationOrderId !== shipstationOrderId) {
    conflicts.push(`shipstation_order_id=${existingShipstationOrderId}`);
  }
  if (existingShipstationOrderKey !== null && existingShipstationOrderKey !== shipstationOrderKey) {
    conflicts.push(`shipstation_order_key=${existingShipstationOrderKey}`);
  }

  if (conflicts.length > 0) {
    return {
      kind: "identity_conflict",
      reason: `existing provider-order identity conflicts with ShipStation: ${conflicts.join(", ")}`,
    };
  }

  return {
    ...physicalDecision,
    providerOrderLinkage: {
      shippingEngine: "shipstation",
      engineOrderRef: expectedOrderRef,
      engineShipmentRef: shipstationOrderKey,
      shipstationOrderId,
      shipstationOrderKey,
    },
    reason: "exact physical-shipment and tracking match with compatible provider-order identity",
  };
}

export function buildCandidateSql(flags: Pick<Flags, "limit" | "orderNumber" | "wmsShipmentId"> & {
  scope?: EnrichmentScope;
}): {
  sql: string;
  params: unknown[];
} {
  const scope = flags.scope ?? "physical-id";
  const where: string[] = [
    "s.status::text = 'shipped'",
    "NULLIF(BTRIM(COALESCE(s.tracking_number, '')), '') IS NOT NULL",
  ];
  if (scope === "physical-id") {
    where.push(
      "NULLIF(BTRIM(COALESCE(s.external_fulfillment_id, '')), '') IS NULL",
      "COALESCE(NULLIF(BTRIM(s.shipping_engine), ''), 'shipstation') = 'shipstation'",
    );
  } else {
    where.push(
      `(s.external_fulfillment_id ~ '^shipstation_shipment:[0-9]+$'
        OR s.external_fulfillment_id ~ '^shipstation_combined:[0-9]+:order:[0-9]+$'
        OR s.external_fulfillment_id ~ '^provider_physical:v1:shipstation:[0-9]+$')`,
      `(NULLIF(BTRIM(COALESCE(s.shipping_engine, '')), '') IS NULL
        OR NULLIF(BTRIM(COALESCE(s.engine_order_ref, '')), '') IS NULL
        OR NULLIF(BTRIM(COALESCE(s.engine_shipment_ref, '')), '') IS NULL
        OR s.shipstation_order_id IS NULL
        OR NULLIF(BTRIM(COALESCE(s.shipstation_order_key, '')), '') IS NULL)`,
    );
  }
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
        s.external_fulfillment_id,
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
          `[ShipStation identity enrich] RETRY attempt=${attempt + 1}/${flags.maxRetries} ` +
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

export function applyProviderOrderLinkageSql(): string {
  return `
      UPDATE wms.outbound_shipments
      SET shipping_engine = $1::varchar,
          engine_order_ref = $2::varchar,
          engine_shipment_ref = $3::varchar,
          shipstation_order_id = $4::integer,
          shipstation_order_key = $5::varchar,
          updated_at = NOW()
      WHERE id = $6::integer
        AND status::text = 'shipped'
        AND tracking_number IS NOT DISTINCT FROM $7::varchar
        AND external_fulfillment_id IS NOT DISTINCT FROM $8::varchar
        AND shipping_engine IS NOT DISTINCT FROM $9::varchar
        AND engine_order_ref IS NOT DISTINCT FROM $10::varchar
        AND engine_shipment_ref IS NOT DISTINCT FROM $11::varchar
        AND shipstation_order_id IS NOT DISTINCT FROM $12::integer
        AND shipstation_order_key IS NOT DISTINCT FROM $13::varchar
      RETURNING
        id,
        status::text AS status,
        tracking_number,
        external_fulfillment_id,
        shipping_engine,
        engine_order_ref,
        engine_shipment_ref,
        shipstation_order_id,
        shipstation_order_key
    `;
}

export function insertProviderOrderLinkageAuditSql(): string {
  return `
      INSERT INTO wms.oms_wms_authority_cleanup_audit (
        run_id,
        operation,
        source_table,
        source_id,
        action,
        reason,
        before_row,
        after_row,
        operator
      ) VALUES (
        $1::uuid,
        'shipstation-provider-order-linkage',
        'wms.outbound_shipments',
        $2::bigint,
        'update',
        'Exact ShipStation physical shipment and tracking match supplied missing provider-order linkage',
        $3::jsonb,
        $4::jsonb,
        $5::text
      )
    `;
}

async function applyProviderOrderLinkage(
  client: PoolClient,
  candidate: CandidateRow,
  linkage: ShipStationProviderOrderLinkage,
  runId: string,
  operator: string,
): Promise<{ updated: boolean; skippedReason: string | null }> {
  const result = await client.query(
    applyProviderOrderLinkageSql(),
    [
      linkage.shippingEngine,
      linkage.engineOrderRef,
      linkage.engineShipmentRef,
      linkage.shipstationOrderId,
      linkage.shipstationOrderKey,
      candidate.legacy_shipment_id,
      candidate.tracking_number,
      candidate.external_fulfillment_id,
      candidate.shipping_engine,
      candidate.engine_order_ref,
      candidate.engine_shipment_ref,
      candidate.shipstation_order_id,
      candidate.shipstation_order_key,
    ],
  );

  if (result.rowCount === 1) {
    const beforeRow = {
      id: candidate.legacy_shipment_id,
      status: candidate.legacy_shipment_status,
      tracking_number: candidate.tracking_number,
      external_fulfillment_id: candidate.external_fulfillment_id,
      shipping_engine: candidate.shipping_engine,
      engine_order_ref: candidate.engine_order_ref,
      engine_shipment_ref: candidate.engine_shipment_ref,
      shipstation_order_id: candidate.shipstation_order_id,
      shipstation_order_key: candidate.shipstation_order_key,
    };
    await client.query(
      insertProviderOrderLinkageAuditSql(),
      [
        runId,
        candidate.legacy_shipment_id,
        JSON.stringify(beforeRow),
        JSON.stringify(result.rows[0]),
        operator,
      ],
    );
  }

  return {
    updated: result.rowCount === 1,
    skippedReason: result.rowCount === 1 ? null : "guarded update matched no rows",
  };
}

export function shouldPersistEnrichment(mode: Mode, decision: MatchDecision): boolean {
  return mode === "execute" && decision.kind === "match";
}

function printOutcome(outcome: CandidateOutcome, mode: Mode, scope: EnrichmentScope): void {
  const c = outcome.candidate;
  if (outcome.decision.kind === "match") {
    const action = mode === "execute"
      ? outcome.updated ? "UPDATE" : "SKIP_UPDATE"
      : "PLAN";
    if (scope === "provider-order-linkage" && outcome.decision.providerOrderLinkage) {
      const linkage = outcome.decision.providerOrderLinkage;
      console.log(
        `[ShipStation identity enrich] ${action} scope=${scope} wms=${c.legacy_shipment_id} `
        + `order=${c.order_number ?? "unknown"} physical=${outcome.decision.externalFulfillmentId} `
        + `shippingEngine=${c.shipping_engine ?? "null"}->${linkage.shippingEngine} `
        + `engineOrderRef=${c.engine_order_ref ?? "null"}->${linkage.engineOrderRef} `
        + `engineShipmentRef=${c.engine_shipment_ref ?? "null"}->${linkage.engineShipmentRef} `
        + `shipstationOrderId=${c.shipstation_order_id ?? "null"}->${linkage.shipstationOrderId} `
        + `shipstationOrderKey=${c.shipstation_order_key ?? "null"}->${linkage.shipstationOrderKey}`
        + `${outcome.updateSkippedReason ? ` reason="${outcome.updateSkippedReason}"` : ""}`,
      );
      return;
    }
    console.log(
      `[ShipStation identity enrich] ${action} scope=${scope} wms=${c.legacy_shipment_id} order=${c.order_number ?? "unknown"} ` +
      `ssOrder=${c.shipstation_order_id ?? "unknown"} tracking=${c.tracking_number} -> ${outcome.decision.externalFulfillmentId}` +
      `${outcome.updateSkippedReason ? ` reason="${outcome.updateSkippedReason}"` : ""}`,
    );
    return;
  }

  console.log(
    `[ShipStation identity enrich] ${outcome.decision.kind.toUpperCase()} scope=${scope} wms=${c.legacy_shipment_id} ` +
    `order=${c.order_number ?? "unknown"} ssOrder=${c.shipstation_order_id ?? "unknown"} tracking=${c.tracking_number} ` +
    `${outcome.decision.providerStatus != null ? `status=${outcome.decision.providerStatus} ` : ""}` +
    `reason="${outcome.decision.reason}"`,
  );
}

function summarizeOutcomes(
  runId: string,
  mode: Mode,
  scope: EnrichmentScope,
  outcomes: CandidateOutcome[],
  errors: number,
  rateLimitResponses: number,
  stoppedEarlyReason: string | null = null,
): EnrichmentResult {
  return {
    runId,
    mode,
    scope,
    candidates: outcomes.length,
    matched: outcomes.filter((outcome) => outcome.decision.kind === "match").length,
    updated: outcomes.filter((outcome) => outcome.updated).length,
    noMatch: outcomes.filter((outcome) => outcome.decision.kind === "no_match").length,
    ambiguous: outcomes.filter((outcome) => outcome.decision.kind === "ambiguous").length,
    invalidCandidate: outcomes.filter((outcome) => outcome.decision.kind === "invalid_candidate").length,
    identityConflicts: outcomes.filter((outcome) => outcome.decision.kind === "identity_conflict").length,
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
  runId: string,
): Promise<ProcessedCandidate> {
  try {
    const shipments = await fetchShipStationShipmentsByOrder(candidate, authHeader, flags, rateLimitCircuit);
    const physicalDecision = decideShipStationPhysicalMatch(candidate, shipments);
    const decision = flags.scope === "provider-order-linkage"
      ? decideShipStationProviderOrderLinkage(candidate, physicalDecision)
      : physicalDecision;
    let updated = false;
    let updateSkippedReason: string | null = null;

    if (shouldPersistEnrichment(flags.mode, decision) && decision.kind === "match") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const update = flags.scope === "provider-order-linkage"
          ? decision.providerOrderLinkage
            ? await applyProviderOrderLinkage(
              client,
              candidate,
              decision.providerOrderLinkage,
              runId,
              flags.operator,
            )
            : { updated: false, skippedReason: "provider-order linkage was not resolved" }
          : await applyExternalFulfillmentId(client, candidate, decision.externalFulfillmentId);
        updated = update.updated;
        updateSkippedReason = update.skippedReason;
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (isPostgresUniqueViolation(err)) {
          updateSkippedReason = flags.scope === "provider-order-linkage"
            ? "provider-order identity conflicts with another shipment"
            : "external fulfillment id already belongs to another shipment";
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

function printCandidateLookup(
  index: number,
  total: number,
  candidate: CandidateRow,
  scope: EnrichmentScope,
): void {
  console.log(
    `[ShipStation identity enrich] LOOKUP ${index}/${total} scope=${scope} wms=${candidate.legacy_shipment_id} ` +
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
  scope: EnrichmentScope,
  outcomes: CandidateOutcome[],
  errors: number,
  rateLimitResponses: number,
  total: number,
  startedAtMs: number,
): void {
  const summary = summarizeOutcomes(runId, mode, scope, outcomes, errors, rateLimitResponses);
  console.log(
    `[ShipStation identity enrich] PROGRESS ${JSON.stringify({
      runId,
      processed: summary.candidates,
      total,
      matched: summary.matched,
      updated: summary.updated,
      noMatch: summary.noMatch,
      ambiguous: summary.ambiguous,
      invalidCandidate: summary.invalidCandidate,
      identityConflicts: summary.identityConflicts,
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
          printCandidateLookup(index + 1, candidates.length, candidate, flags.scope);
        }

        const processedCandidate = await enrichCandidate(
          pool,
          candidate,
          authHeader,
          flags,
          rateLimitCircuit,
          runId,
        );
        outcomesByIndex[index] = processedCandidate.outcome;
        if (processedCandidate.error) errors += 1;
        outcomes.push(processedCandidate.outcome);
        processed += 1;

        if (!flags.json) printOutcome(processedCandidate.outcome, flags.mode, flags.scope);
        if (!flags.json && shouldPrintProgress(flags.progressEvery, processed, candidates.length)) {
          printProgress(
            runId,
            flags.mode,
            flags.scope,
            outcomes,
            errors,
            rateLimitCircuit.rateLimitResponses,
            candidates.length,
            startedAtMs,
          );
        }

        if (rateLimitCircuit.stoppedEarlyReason !== null) {
          if (!flags.json) {
            console.error(`[ShipStation identity enrich] STOP ${rateLimitCircuit.stoppedEarlyReason}`);
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
      flags.scope,
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
      `[ShipStation identity enrich] mode=${flags.mode} scope=${flags.scope} limit=${flags.limit ?? "all"} ` +
      `concurrency=${flags.concurrency} delayMs=${flags.delayMs}` +
      ` requestTimeoutMs=${flags.requestTimeoutMs} maxRetries=${flags.maxRetries}` +
      ` retryBaseDelayMs=${flags.retryBaseDelayMs} maxRateLimitErrors=${flags.maxRateLimitErrors}` +
      ` progressEvery=${flags.progressEvery}` +
      `${flags.orderNumber ? ` orderNumber=${flags.orderNumber}` : ""}` +
      `${flags.wmsShipmentId ? ` wmsShipmentId=${flags.wmsShipmentId}` : ""}` +
      `${flags.scope === "provider-order-linkage" ? ` operator=${flags.operator}` : ""}`,
    );
  }

  const result = await runEnrichment(flags);
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `[ShipStation identity enrich] complete ${JSON.stringify({
        runId: result.runId,
        scope: result.scope,
        candidates: result.candidates,
        matched: result.matched,
        updated: result.updated,
        noMatch: result.noMatch,
        ambiguous: result.ambiguous,
        invalidCandidate: result.invalidCandidate,
        identityConflicts: result.identityConflicts,
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
    console.error("[ShipStation identity enrich] fatal:", err);
    process.exit(1);
  });
}
