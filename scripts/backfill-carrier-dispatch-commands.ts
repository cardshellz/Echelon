/**
 * Materialize dispatch commands for confirmed carrier-possession events that
 * were retained while carrier tracking operated in shadow mode.
 *
 * Dry-run is the default. Execute mode only inserts idempotent dispatch
 * commands; the normal leased carrier-dispatch scheduler applies them.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

type Mode = "dry-run" | "execute";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 10_000;

export interface Flags {
  help: boolean;
  mode: Mode;
  limit: number | null;
  orderNumber: string | null;
  operator: string | null;
  json: boolean;
}

export interface CarrierDispatchBackfillCandidate {
  shippingProviderLabelId: number;
  carrierTrackingEventId: number;
  provider: string;
  providerLabelId: string;
  trackingNumber: string;
  orderNumbers: string[];
  dispatchOccurredAt: Date;
}

export interface CarrierDispatchBackfillResult {
  mode: Mode;
  candidates: number;
  inserted: number;
  alreadyPresent: number;
  noLongerEligible: number;
  failures: Array<{
    shippingProviderLabelId: number;
    carrierTrackingEventId: number;
    message: string;
  }>;
}

export interface CarrierDispatchBackfillDependencies {
  loadCandidates(flags: Flags): Promise<CarrierDispatchBackfillCandidate[]>;
  enqueue(
    candidate: CarrierDispatchBackfillCandidate,
    operator: string,
  ): Promise<"inserted" | "already_present" | "no_longer_eligible">;
  log(message: string): void;
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
    "  npx tsx scripts/backfill-carrier-dispatch-commands.ts --dry-run --limit=25",
    "  npx tsx scripts/backfill-carrier-dispatch-commands.ts --execute --limit=all --operator=owner@example.com",
    "  npx tsx scripts/backfill-carrier-dispatch-commands.ts --dry-run --order-number=#60434",
    "",
    "Flags:",
    "  --dry-run              Preview eligible shadow-era events. Default.",
    "  --execute              Insert idempotent dispatch commands.",
    "  --limit=N|all          Maximum labels to inspect. Default 25, max 10000.",
    "  --order-number=TEXT    Restrict to one sales-channel order number.",
    "  --operator=IDENTITY    Required in execute mode; stored on every command.",
    "  --json                 Print only the final machine-readable result.",
    "",
    "Execute mode does not directly write fulfillment or inventory.",
    "The normal leased carrier-dispatch scheduler processes inserted commands.",
  ].join("\n");
}

export function parseFlags(argv: string[]): Flags {
  for (const arg of argv) {
    if (["--help", "-h", "--dry-run", "--execute", "--json"].includes(arg)) continue;
    if (/^--(limit|order-number|operator)=/.test(arg)) continue;
    throw new Error(`Unknown flag: ${arg}`);
  }
  if (argv.includes("--dry-run") && argv.includes("--execute")) {
    throw new Error("Choose either --dry-run or --execute, not both");
  }

  const mode: Mode = argv.includes("--execute") ? "execute" : "dry-run";
  const operator = optionalTextFlag(argv, "--operator=");
  if (mode === "execute" && !operator) {
    throw new Error("--operator is required in execute mode");
  }

  return {
    help: argv.includes("--help") || argv.includes("-h"),
    mode,
    limit: limitFlag(argv),
    orderNumber: optionalTextFlag(argv, "--order-number="),
    operator,
    json: argv.includes("--json"),
  };
}

export async function loadCarrierDispatchBackfillCandidates(
  queryable: Queryable,
  flags: Pick<Flags, "limit" | "orderNumber">,
): Promise<CarrierDispatchBackfillCandidate[]> {
  const result = await queryable.query(`
    WITH latest_match AS (
      SELECT DISTINCT ON (match.carrier_tracking_event_id)
        match.carrier_tracking_event_id,
        match.shipping_provider_label_id,
        match.match_status
      FROM wms.carrier_tracking_event_matches AS match
      ORDER BY
        match.carrier_tracking_event_id,
        match.created_at DESC,
        match.id DESC
    ),
    label_order_context AS (
      SELECT
        link.shipping_provider_label_id,
        ARRAY_REMOVE(
          ARRAY_AGG(
            DISTINCT COALESCE(
              oms_order.external_order_number,
              wms_order.order_number
            )
          ),
          NULL
        ) AS order_numbers
      FROM wms.shipping_provider_label_links AS link
      LEFT JOIN wms.shipment_requests AS direct_request
        ON direct_request.id = link.shipment_request_id
      LEFT JOIN wms.shipping_engine_orders AS engine_order
        ON engine_order.id = link.shipping_engine_order_id
      LEFT JOIN wms.shipment_requests AS engine_request
        ON engine_request.id = engine_order.shipment_request_id
      LEFT JOIN wms.physical_shipments AS physical
        ON physical.id = link.physical_shipment_id
      LEFT JOIN wms.shipment_requests AS physical_request
        ON physical_request.id = physical.shipment_request_id
      LEFT JOIN wms.outbound_shipments AS legacy
        ON legacy.id = link.legacy_wms_shipment_id
      LEFT JOIN wms.orders AS wms_order
        ON wms_order.id = COALESCE(
          direct_request.wms_order_id,
          engine_request.wms_order_id,
          physical_request.wms_order_id,
          legacy.order_id
        )
      LEFT JOIN oms.oms_orders AS oms_order
        ON oms_order.id = CASE
          WHEN wms_order.source IN ('oms', 'ebay')
           AND wms_order.oms_fulfillment_order_id ~ '^[1-9][0-9]{0,17}$'
          THEN wms_order.oms_fulfillment_order_id::bigint
          WHEN wms_order.source_table_id ~ '^[1-9][0-9]{0,17}$'
          THEN wms_order.source_table_id::bigint
          ELSE NULL
        END
      GROUP BY link.shipping_provider_label_id
    ),
    eligible AS (
      SELECT DISTINCT ON (label.id)
        label.id AS shipping_provider_label_id,
        event.id AS carrier_tracking_event_id,
        label.provider,
        label.provider_label_id,
        label.tracking_number,
        context.order_numbers,
        COALESCE(event.event_occurred_at, event.received_at)
          AS dispatch_occurred_at
      FROM wms.carrier_tracking_events AS event
      JOIN latest_match AS match
        ON match.carrier_tracking_event_id = event.id
       AND match.match_status = 'matched'
      JOIN wms.shipping_provider_labels AS label
        ON label.id = match.shipping_provider_label_id
      JOIN label_order_context AS context
        ON context.shipping_provider_label_id = label.id
      WHERE event.dispatch_evidence = 'confirmed'
        AND label.label_status IN ('active', 'unknown')
        AND CARDINALITY(context.order_numbers) > 0
        AND (
          $1::text IS NULL
          OR $1::text = ANY(context.order_numbers)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM wms.carrier_dispatch_commands AS command
          WHERE command.shipping_provider_label_id = label.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM wms.physical_shipments AS physical
          WHERE physical.shipping_provider = label.provider
            AND physical.provider_physical_shipment_id = label.provider_label_id
        )
      ORDER BY
        label.id,
        COALESCE(event.event_occurred_at, event.received_at),
        event.id
    )
    SELECT *
    FROM eligible
    ORDER BY dispatch_occurred_at, shipping_provider_label_id
    LIMIT $2::integer
  `, [
    flags.orderNumber,
    flags.limit ?? MAX_LIMIT,
  ]);

  return result.rows.map((row) => ({
    shippingProviderLabelId: positiveInteger(
      row.shipping_provider_label_id,
      "shipping_provider_label_id",
    ),
    carrierTrackingEventId: positiveInteger(
      row.carrier_tracking_event_id,
      "carrier_tracking_event_id",
    ),
    provider: requiredText(row.provider, "provider"),
    providerLabelId: requiredText(row.provider_label_id, "provider_label_id"),
    trackingNumber: requiredText(row.tracking_number, "tracking_number"),
    orderNumbers: textArray(row.order_numbers, "order_numbers"),
    dispatchOccurredAt: requiredDate(
      row.dispatch_occurred_at,
      "dispatch_occurred_at",
    ),
  }));
}

export async function enqueueCarrierDispatchBackfillCommand(
  queryable: Queryable,
  candidate: CarrierDispatchBackfillCandidate,
  operator: string,
): Promise<"inserted" | "already_present" | "no_longer_eligible"> {
  const commandKey =
    `carrier-dispatch:shipping-provider-label:${candidate.shippingProviderLabelId}`;
  const result = await queryable.query(`
    INSERT INTO wms.carrier_dispatch_commands (
      shipping_provider_label_id,
      carrier_tracking_event_id,
      command_key,
      source,
      created_by,
      status,
      dispatch_occurred_at,
      created_at,
      updated_at
    )
    SELECT
      label.id,
      event.id,
      $3::text,
      'shadow_cutover_backfill',
      $4::text,
      'pending',
      $5::timestamptz,
      NOW(),
      NOW()
    FROM wms.shipping_provider_labels AS label
    JOIN wms.carrier_tracking_events AS event
      ON event.id = $2::bigint
    WHERE label.id = $1::bigint
      AND label.label_status IN ('active', 'unknown')
      AND event.dispatch_evidence = 'confirmed'
      AND EXISTS (
        SELECT 1
        FROM wms.carrier_tracking_event_matches AS match
        WHERE match.carrier_tracking_event_id = event.id
          AND match.shipping_provider_label_id = label.id
          AND match.match_status = 'matched'
          AND match.id = (
            SELECT latest_match.id
            FROM wms.carrier_tracking_event_matches AS latest_match
            WHERE latest_match.carrier_tracking_event_id = event.id
            ORDER BY latest_match.created_at DESC, latest_match.id DESC
            LIMIT 1
          )
      )
      AND EXISTS (
        SELECT 1
        FROM wms.shipping_provider_label_links AS link
        WHERE link.shipping_provider_label_id = label.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM wms.physical_shipments AS physical
        WHERE physical.shipping_provider = label.provider
          AND physical.provider_physical_shipment_id = label.provider_label_id
      )
    ON CONFLICT (shipping_provider_label_id) DO NOTHING
    RETURNING id
  `, [
    candidate.shippingProviderLabelId,
    candidate.carrierTrackingEventId,
    commandKey,
    operator,
    candidate.dispatchOccurredAt.toISOString(),
  ]);
  if (result.rows.length === 1) return "inserted";

  const existing = await queryable.query(`
    SELECT id
    FROM wms.carrier_dispatch_commands
    WHERE shipping_provider_label_id = $1::bigint
    LIMIT 1
  `, [candidate.shippingProviderLabelId]);
  return existing.rows.length > 0 ? "already_present" : "no_longer_eligible";
}

export async function runCarrierDispatchBackfill(
  flags: Flags,
  dependencies: CarrierDispatchBackfillDependencies,
): Promise<CarrierDispatchBackfillResult> {
  const candidates = await dependencies.loadCandidates(flags);
  const result: CarrierDispatchBackfillResult = {
    mode: flags.mode,
    candidates: candidates.length,
    inserted: 0,
    alreadyPresent: 0,
    noLongerEligible: 0,
    failures: [],
  };

  for (const candidate of candidates) {
    const context = [
      `label=${candidate.shippingProviderLabelId}`,
      `event=${candidate.carrierTrackingEventId}`,
      `provider=${candidate.provider}:${candidate.providerLabelId}`,
      `orders=${candidate.orderNumbers.join(",")}`,
      `dispatchAt=${candidate.dispatchOccurredAt.toISOString()}`,
    ].join(" ");
    if (flags.mode === "dry-run") {
      dependencies.log(`[Carrier dispatch backfill] PLAN ${context}`);
      continue;
    }

    try {
      const outcome = await dependencies.enqueue(
        candidate,
        flags.operator!,
      );
      if (outcome === "inserted") result.inserted += 1;
      else if (outcome === "already_present") result.alreadyPresent += 1;
      else result.noLongerEligible += 1;
      dependencies.log(
        `[Carrier dispatch backfill] ${outcome.toUpperCase()} ${context}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failures.push({
        shippingProviderLabelId: candidate.shippingProviderLabelId,
        carrierTrackingEventId: candidate.carrierTrackingEventId,
        message,
      });
      dependencies.log(`[Carrier dispatch backfill] ERROR ${context} error=${message}`);
    }
  }

  return result;
}

function limitFlag(argv: string[]): number | null {
  const raw = optionalTextFlag(argv, "--limit=");
  if (raw === null) return DEFAULT_LIMIT;
  if (raw === "all") return null;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`--limit must be an integer from 1 through ${MAX_LIMIT}, or all`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_LIMIT) {
    throw new Error(`--limit must be an integer from 1 through ${MAX_LIMIT}, or all`);
  }
  return parsed;
}

function optionalTextFlag(argv: string[], prefix: string): string | null {
  const raw = argv.find((arg) => arg.startsWith(prefix));
  if (!raw) return null;
  const value = raw.slice(prefix.length).trim();
  if (!value) throw new Error(`${prefix.slice(0, -1)} cannot be blank`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${field} returned by carrier dispatch backfill`);
  }
  return parsed;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${field} returned by carrier dispatch backfill`);
  }
  return value.trim();
}

function textArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${field} returned by carrier dispatch backfill`);
  }
  return value.map((entry) => requiredText(entry, field));
}

function requiredDate(value: unknown, field: string): Date {
  const date = value instanceof Date ? new Date(value) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid ${field} returned by carrier dispatch backfill`);
  }
  return date;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const databaseModule = await import("../server/db");
  try {
    const result = await runCarrierDispatchBackfill(flags, {
      loadCandidates: (input) =>
        loadCarrierDispatchBackfillCandidates(databaseModule.pool, input),
      enqueue: (candidate, operator) =>
        enqueueCarrierDispatchBackfillCommand(
          databaseModule.pool,
          candidate,
          operator,
        ),
      log: flags.json ? () => {} : (message) => console.log(message),
    });
    const output = JSON.stringify(result);
    if (flags.json) console.log(output);
    else console.log(`[Carrier dispatch backfill] complete ${output}`);
    if (result.failures.length > 0) process.exitCode = 2;
  } finally {
    await databaseModule.pool.end();
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(`[Carrier dispatch backfill] fatal: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
