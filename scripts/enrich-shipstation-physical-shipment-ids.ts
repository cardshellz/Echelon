/**
 * Enrich legacy WMS shipment rows with the stable ShipStation physical
 * shipment id.
 *
 * This script is intentionally conservative:
 * - dry-run by default
 * - fetches ShipStation by both orderId and orderNumber because split
 *   ShipStation children may not be returned by parent orderId alone
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
  delayMs: number;
  requestTimeoutMs: number;
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
  shipstation_order_id: number;
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
      kind: "no_match" | "ambiguous" | "invalid_candidate";
      reason: string;
      matchingShipmentIds?: number[];
    };

interface CandidateOutcome {
  candidate: CandidateRow;
  decision: MatchDecision;
  updated: boolean;
  updateSkippedReason: string | null;
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
  updateSkipped: number;
  errors: number;
  outcomes: CandidateOutcome[];
}

const DEFAULT_LIMIT = 25;
const DEFAULT_DELAY_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_PROGRESS_EVERY = 25;
const DEFAULT_BASE_URL = "https://ssapi.shipstation.com";

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
    "  --delay-ms=N           Delay between ShipStation lookups. Default 250.",
    "  --request-timeout-ms=N Abort each ShipStation HTTP request after N ms. Default 20000.",
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

  const knownFlag = /^(--help|-h|--dry-run|--execute|--limit=|--delay-ms=|--request-timeout-ms=|--progress-every=|--order-number=|--wms-shipment-id=|--json$)/;
  const unknown = argv.find((arg) => !knownFlag.test(arg));
  if (unknown) {
    throw new Error(`Unknown flag: ${unknown}`);
  }

  const limit = parseOptionalPositiveIntegerFlag(argv, "--limit=", DEFAULT_LIMIT, true);
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
    delayMs,
    requestTimeoutMs,
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

export function buildShipStationShipmentsPath(params: { orderId?: number; orderNumber?: string | null }): string {
  const search = new URLSearchParams();
  if (params.orderId != null) search.set("orderId", String(params.orderId));
  if (params.orderNumber != null && params.orderNumber.trim().length > 0) {
    search.set("orderNumber", params.orderNumber.trim());
  }
  search.set("includeShipmentItems", "true");
  return `/shipments?${search.toString()}`;
}

export function buildShipStationShipmentsUrl(
  baseUrl: string,
  params: { orderId?: number; orderNumber?: string | null },
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
    "s.shipstation_order_id IS NOT NULL",
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

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
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
      throw new Error(`ShipStation GET ${url} failed ${res.status}: ${text.slice(0, 500)}`);
    }
    return await res.json() as T;
  } catch (err) {
    if (isAbortError(err)) {
      throw new Error(`ShipStation GET ${url} timed out after ${requestTimeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchShipStationShipmentsByOrder(
  candidate: CandidateRow,
  authHeader: string,
  requestTimeoutMs: number,
): Promise<ShipStationShipmentCandidate[]> {
  const baseUrl = process.env.SHIPSTATION_API_BASE_URL || DEFAULT_BASE_URL;
  const urls = [
    buildShipStationShipmentsUrl(baseUrl, { orderId: candidate.shipstation_order_id }),
  ];
  if (candidate.order_number) {
    urls.push(buildShipStationShipmentsUrl(baseUrl, { orderNumber: candidate.order_number }));
  }

  const shipments: ShipStationShipmentCandidate[] = [];
  for (const url of urls) {
    const body = await fetchShipStationJsonWithTimeout<{ shipments?: ShipStationShipmentCandidate[] }>(
      url,
      authHeader,
      requestTimeoutMs,
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

async function applyExternalFulfillmentId(
  client: PoolClient,
  candidate: CandidateRow,
  externalFulfillmentId: string,
): Promise<{ updated: boolean; skippedReason: string | null }> {
  if (await hasExternalFulfillmentConflict(client, candidate.legacy_shipment_id, externalFulfillmentId)) {
    return { updated: false, skippedReason: "external fulfillment id already belongs to another shipment" };
  }

  const result = await client.query(
    `
      UPDATE wms.outbound_shipments
      SET external_fulfillment_id = $1,
          updated_at = NOW()
      WHERE id = $2
        AND status::text = 'shipped'
        AND shipstation_order_id = $3
        AND tracking_number = $4
        AND NULLIF(BTRIM(COALESCE(external_fulfillment_id, '')), '') IS NULL
      RETURNING id
    `,
    [
      externalFulfillmentId,
      candidate.legacy_shipment_id,
      candidate.shipstation_order_id,
      candidate.tracking_number,
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
      `ssOrder=${c.shipstation_order_id} tracking=${c.tracking_number} -> ${outcome.decision.externalFulfillmentId}` +
      `${outcome.updateSkippedReason ? ` reason="${outcome.updateSkippedReason}"` : ""}`,
    );
    return;
  }

  console.log(
    `[ShipStation physical id enrich] ${outcome.decision.kind.toUpperCase()} wms=${c.legacy_shipment_id} ` +
    `order=${c.order_number ?? "unknown"} ssOrder=${c.shipstation_order_id} tracking=${c.tracking_number} ` +
    `reason="${outcome.decision.reason}"`,
  );
}

function summarizeOutcomes(runId: string, mode: Mode, outcomes: CandidateOutcome[], errors: number): EnrichmentResult {
  return {
    runId,
    mode,
    candidates: outcomes.length,
    matched: outcomes.filter((outcome) => outcome.decision.kind === "match").length,
    updated: outcomes.filter((outcome) => outcome.updated).length,
    noMatch: outcomes.filter((outcome) => outcome.decision.kind === "no_match").length,
    ambiguous: outcomes.filter((outcome) => outcome.decision.kind === "ambiguous").length,
    invalidCandidate: outcomes.filter((outcome) => outcome.decision.kind === "invalid_candidate").length,
    updateSkipped: outcomes.filter((outcome) => outcome.updateSkippedReason !== null).length,
    errors,
    outcomes,
  };
}

function printCandidateLookup(index: number, total: number, candidate: CandidateRow): void {
  console.log(
    `[ShipStation physical id enrich] LOOKUP ${index}/${total} wms=${candidate.legacy_shipment_id} ` +
    `order=${candidate.order_number ?? "unknown"} ssOrder=${candidate.shipstation_order_id} ` +
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
  total: number,
  startedAtMs: number,
): void {
  const summary = summarizeOutcomes(runId, mode, outcomes, errors);
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

  try {
    const candidates = await fetchCandidates(pool, flags);
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!flags.json) {
        printCandidateLookup(index + 1, candidates.length, candidate);
      }

      try {
        const shipments = await fetchShipStationShipmentsByOrder(candidate, authHeader, flags.requestTimeoutMs);
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
            throw err;
          } finally {
            client.release();
          }
        }

        const outcome = { candidate, decision, updated, updateSkippedReason };
        outcomes.push(outcome);
        if (!flags.json) printOutcome(outcome, flags.mode);
      } catch (err: any) {
        errors += 1;
        const decision: MatchDecision = {
          kind: "no_match",
          reason: err?.message || String(err),
        };
        const outcome = { candidate, decision, updated: false, updateSkippedReason: "lookup failed" };
        outcomes.push(outcome);
        if (!flags.json) printOutcome(outcome, flags.mode);
      }

      if (!flags.json && shouldPrintProgress(flags.progressEvery, index + 1, candidates.length)) {
        printProgress(runId, flags.mode, outcomes, errors, candidates.length, startedAtMs);
      }

      if (index < candidates.length - 1) {
        await sleep(flags.delayMs);
      }
    }

    return summarizeOutcomes(runId, flags.mode, outcomes, errors);
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
      `[ShipStation physical id enrich] mode=${flags.mode} limit=${flags.limit ?? "all"} delayMs=${flags.delayMs}` +
      ` requestTimeoutMs=${flags.requestTimeoutMs} progressEvery=${flags.progressEvery}` +
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
        updateSkipped: result.updateSkipped,
        errors: result.errors,
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
