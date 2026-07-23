/**
 * Materialize canonical physical-package and channel-fulfillment command rows
 * for shipped legacy WMS packages that are not fully represented yet.
 *
 * Dry-run is the default. Execute mode only commits canonical database state;
 * it never calls a sales-channel API. The leased fulfillment command worker is
 * the sole provider dispatcher after pending commands are created.
 *
 * Usage:
 *   npx tsx scripts/backfill-channel-fulfillment-authority.ts --dry-run --limit=100
 *   npx tsx scripts/backfill-channel-fulfillment-authority.ts --execute --limit=all
 *   npx tsx scripts/backfill-channel-fulfillment-authority.ts --order-number=#59564
 *   npx tsx scripts/backfill-channel-fulfillment-authority.ts --wms-shipment-id=4842
 */

import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ChannelFulfillmentAuthorityRepository,
  MaterializePhysicalPackageResult,
} from "../server/modules/oms/channel-fulfillment-authority.repository";

type Mode = "dry-run" | "execute";

export interface BackfillFlags {
  readonly help: boolean;
  readonly mode: Mode;
  readonly limit: number | null;
  readonly orderNumber: string | null;
  readonly wmsShipmentId: number | null;
  readonly json: boolean;
}

export interface BackfillCandidate {
  readonly representativeShipmentId: number;
  readonly shippingProvider: string;
  readonly providerPhysicalShipmentId: string;
  readonly legacyShipmentIds: readonly number[];
  readonly orderNumbers: readonly string[];
  readonly trackingNumber: string;
  readonly missingPhysicalShipment: boolean;
  readonly missingCommandItemCount: number;
}

export interface BackfillSummary {
  readonly mode: Mode;
  readonly candidates: number;
  readonly materialized: number;
  readonly commandsCreated: number;
  readonly commandsReplayed: number;
  readonly reviewRequired: number;
  readonly failures: readonly Readonly<Record<string, unknown>>[];
}

export interface BackfillDependencies {
  readonly loadCandidates: (flags: BackfillFlags) => Promise<readonly BackfillCandidate[]>;
  readonly repository: Pick<
    ChannelFulfillmentAuthorityRepository,
    "resolveLegacyPhysicalPackage" | "materializePhysicalPackage"
  >;
  readonly log?: (message: string) => void;
}

const DEFAULT_LIMIT = 100;
const BACKFILL_SOURCE = "script:backfill-channel-fulfillment-authority";

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

export function parseFlags(argv: readonly string[]): BackfillFlags {
  const help = argv.includes("--help") || argv.includes("-h");
  const execute = argv.includes("--execute");
  const dryRun = argv.includes("--dry-run");
  if (execute && dryRun) throw new Error("Cannot pass both --execute and --dry-run");

  for (const arg of argv) {
    if (
      arg === "--help"
      || arg === "-h"
      || arg === "--execute"
      || arg === "--dry-run"
      || arg === "--json"
      || arg.startsWith("--limit=")
      || arg.startsWith("--order-number=")
      || arg.startsWith("--wms-shipment-id=")
    ) {
      continue;
    }
    throw new Error(`Unknown flag: ${arg}`);
  }

  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const limitRaw = limitArg?.slice("--limit=".length).trim().toLowerCase() ?? String(DEFAULT_LIMIT);
  const limit = limitRaw === "all" ? null : parsePositiveInteger(limitRaw, "--limit");

  const orderArg = argv.find((arg) => arg.startsWith("--order-number="));
  const orderNumber = orderArg?.slice("--order-number=".length).trim() ?? null;
  if (orderArg && !orderNumber) throw new Error("--order-number cannot be blank");

  const shipmentArg = argv.find((arg) => arg.startsWith("--wms-shipment-id="));
  const wmsShipmentId = shipmentArg
    ? parsePositiveInteger(shipmentArg.slice("--wms-shipment-id=".length).trim(), "--wms-shipment-id")
    : null;

  return Object.freeze({
    help,
    mode: execute ? "execute" : "dry-run",
    limit,
    orderNumber,
    wmsShipmentId,
    json: argv.includes("--json"),
  });
}

export function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/backfill-channel-fulfillment-authority.ts --dry-run --limit=100",
    "  npx tsx scripts/backfill-channel-fulfillment-authority.ts --execute --limit=all",
    "",
    "Flags:",
    "  --dry-run               Report missing canonical coverage. Default.",
    "  --execute               Materialize canonical rows and pending commands.",
    "  --limit=N|all           Maximum physical packages. Default 100.",
    "  --order-number=TEXT     Restrict to one channel-facing order number.",
    "  --wms-shipment-id=N     Restrict to a legacy WMS shipment row.",
    "  --json                  Print the final summary as JSON only.",
  ].join("\n");
}

export interface CandidateQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** Build a parameterized, read-only package coverage query. */
export function buildCandidateQuery(flags: BackfillFlags): CandidateQuery {
  const values: unknown[] = [];
  const filters: string[] = [];
  if (flags.orderNumber) {
    values.push(flags.orderNumber);
    filters.push(`o.order_number = $${values.length}`);
  }
  if (flags.wmsShipmentId) {
    values.push(flags.wmsShipmentId);
    filters.push(`s.id = $${values.length}`);
  }
  const sourceFilter = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";
  let limitClause = "";
  if (flags.limit !== null) {
    values.push(flags.limit);
    limitClause = `LIMIT $${values.length}`;
  }

  return Object.freeze({
    text: `
      WITH legacy_package_rows AS (
        SELECT
          s.id::int AS legacy_shipment_id,
          o.order_number,
          'shipstation'::text AS shipping_provider,
          CASE
            WHEN s.external_fulfillment_id ~ '^shipstation_shipment:[0-9]+$'
              THEN split_part(s.external_fulfillment_id, ':', 2)
            WHEN s.external_fulfillment_id ~ '^shipstation_combined:[0-9]+:order:[0-9]+$'
              THEN split_part(s.external_fulfillment_id, ':', 2)
          END AS provider_physical_shipment_id,
          NULLIF(BTRIM(s.tracking_number), '') AS tracking_number
        FROM wms.outbound_shipments s
        JOIN wms.orders o ON o.id = s.order_id
        WHERE s.status::text = 'shipped'
          AND NULLIF(BTRIM(COALESCE(s.tracking_number, '')), '') IS NOT NULL
          AND NULLIF(BTRIM(COALESCE(s.carrier, '')), '') IS NOT NULL
          AND (
            s.external_fulfillment_id ~ '^shipstation_shipment:[0-9]+$'
            OR s.external_fulfillment_id ~ '^shipstation_combined:[0-9]+:order:[0-9]+$'
          )
          ${sourceFilter}
      ), package_groups AS (
        SELECT
          shipping_provider,
          provider_physical_shipment_id,
          MIN(legacy_shipment_id)::int AS representative_shipment_id,
          ARRAY_AGG(DISTINCT legacy_shipment_id ORDER BY legacy_shipment_id) AS legacy_shipment_ids,
          ARRAY_AGG(DISTINCT order_number ORDER BY order_number) AS order_numbers,
          MIN(tracking_number) AS tracking_number
        FROM legacy_package_rows
        WHERE provider_physical_shipment_id IS NOT NULL
        GROUP BY shipping_provider, provider_physical_shipment_id
      )
      SELECT
        package_group.*,
        physical.id IS NULL AS missing_physical_shipment,
        COALESCE((
          SELECT COUNT(*)::int
          FROM legacy_package_rows package_row
          JOIN wms.outbound_shipment_items legacy_item
            ON legacy_item.shipment_id = package_row.legacy_shipment_id
           AND legacy_item.qty > 0
           AND COALESCE(legacy_item.shipment_item_purpose, 'customer_fulfillment') = 'customer_fulfillment'
          JOIN wms.order_items order_item ON order_item.id = legacy_item.order_item_id
          JOIN oms.oms_order_lines oms_line ON oms_line.id = order_item.oms_order_line_id
          JOIN oms.oms_orders oms_order ON oms_order.id = oms_line.order_id
          JOIN channels.channels channel ON channel.id = oms_order.channel_id
          WHERE package_row.shipping_provider = package_group.shipping_provider
            AND package_row.provider_physical_shipment_id = package_group.provider_physical_shipment_id
            AND COALESCE(NULLIF(LOWER(BTRIM(oms_line.fulfillment_provider)), ''), LOWER(channel.provider)) = LOWER(channel.provider)
            AND NOT EXISTS (
              SELECT 1
              FROM wms.physical_shipment_items physical_item
              JOIN wms.physical_shipments physical_package
                ON physical_package.id = physical_item.physical_shipment_id
              JOIN oms.channel_fulfillment_push_items command_item
                ON command_item.physical_shipment_item_id = physical_item.id
              JOIN oms.channel_fulfillment_pushes command
                ON command.id = command_item.channel_fulfillment_push_id
              WHERE physical_item.legacy_wms_shipment_item_id = legacy_item.id
                AND physical_package.provider = package_group.shipping_provider
                AND physical_package.provider_physical_shipment_id = package_group.provider_physical_shipment_id
                AND command.oms_order_id = oms_order.id
                AND LOWER(command.channel_provider) = LOWER(channel.provider)
            )
        ), 0)::int AS missing_command_item_count
      FROM package_groups package_group
      LEFT JOIN wms.physical_shipments physical
        ON physical.provider = package_group.shipping_provider
       AND physical.provider_physical_shipment_id = package_group.provider_physical_shipment_id
      WHERE physical.id IS NULL
         OR EXISTS (
          SELECT 1
          FROM legacy_package_rows package_row
          JOIN wms.outbound_shipment_items legacy_item
            ON legacy_item.shipment_id = package_row.legacy_shipment_id
           AND legacy_item.qty > 0
           AND COALESCE(legacy_item.shipment_item_purpose, 'customer_fulfillment') = 'customer_fulfillment'
          JOIN wms.order_items order_item ON order_item.id = legacy_item.order_item_id
          JOIN oms.oms_order_lines oms_line ON oms_line.id = order_item.oms_order_line_id
          JOIN oms.oms_orders oms_order ON oms_order.id = oms_line.order_id
          JOIN channels.channels channel ON channel.id = oms_order.channel_id
          WHERE package_row.shipping_provider = package_group.shipping_provider
            AND package_row.provider_physical_shipment_id = package_group.provider_physical_shipment_id
            AND COALESCE(NULLIF(LOWER(BTRIM(oms_line.fulfillment_provider)), ''), LOWER(channel.provider)) = LOWER(channel.provider)
            AND NOT EXISTS (
              SELECT 1
              FROM wms.physical_shipment_items physical_item
              JOIN wms.physical_shipments physical_package
                ON physical_package.id = physical_item.physical_shipment_id
              JOIN oms.channel_fulfillment_push_items command_item
                ON command_item.physical_shipment_item_id = physical_item.id
              JOIN oms.channel_fulfillment_pushes command
                ON command.id = command_item.channel_fulfillment_push_id
              WHERE physical_item.legacy_wms_shipment_item_id = legacy_item.id
                AND physical_package.provider = package_group.shipping_provider
                AND physical_package.provider_physical_shipment_id = package_group.provider_physical_shipment_id
                AND command.oms_order_id = oms_order.id
                AND LOWER(command.channel_provider) = LOWER(channel.provider)
            )
        )
      ORDER BY package_group.representative_shipment_id ASC
      ${limitClause}
    `,
    values: Object.freeze([...values]),
  });
}

function toPositiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Database returned invalid ${field}: ${String(value)}`);
  }
  return parsed;
}

function toCandidate(row: any): BackfillCandidate {
  const legacyShipmentIds = (row.legacy_shipment_ids ?? []).map((value: unknown) =>
    toPositiveInteger(value, "legacy_shipment_id"));
  return Object.freeze({
    representativeShipmentId: toPositiveInteger(
      row.representative_shipment_id,
      "representative_shipment_id",
    ),
    shippingProvider: String(row.shipping_provider),
    providerPhysicalShipmentId: String(row.provider_physical_shipment_id),
    legacyShipmentIds: Object.freeze(legacyShipmentIds),
    orderNumbers: Object.freeze((row.order_numbers ?? []).map(String)),
    trackingNumber: String(row.tracking_number),
    missingPhysicalShipment: row.missing_physical_shipment === true,
    missingCommandItemCount: Number(row.missing_command_item_count ?? 0),
  });
}

function commandCounts(result: MaterializePhysicalPackageResult): {
  created: number;
  replayed: number;
} {
  return result.channelCommands.reduce(
    (count, command) => ({
      created: count.created + (command.replayed ? 0 : 1),
      replayed: count.replayed + (command.replayed ? 1 : 0),
    }),
    { created: 0, replayed: 0 },
  );
}

export async function runBackfill(
  flags: BackfillFlags,
  dependencies: BackfillDependencies,
): Promise<BackfillSummary> {
  const log = dependencies.log ?? console.log;
  const candidates = await dependencies.loadCandidates(flags);
  let materialized = 0;
  let commandsCreated = 0;
  let commandsReplayed = 0;
  let reviewRequired = 0;
  const failures: Array<Readonly<Record<string, unknown>>> = [];

  if (!flags.json) {
    log(
      `[Channel fulfillment authority backfill] mode=${flags.mode} candidates=${candidates.length} limit=${flags.limit ?? "all"}`,
    );
  }

  for (const candidate of candidates) {
    if (!flags.json) {
      log(
        `[Channel fulfillment authority backfill] ${flags.mode === "execute" ? "MATERIALIZE" : "PLAN"} `
        + `shipment=${candidate.representativeShipmentId} orders=${candidate.orderNumbers.join(",")} `
        + `provider=${candidate.shippingProvider}:${candidate.providerPhysicalShipmentId} `
        + `tracking=${candidate.trackingNumber} missingPhysical=${candidate.missingPhysicalShipment} `
        + `missingCommandItems=${candidate.missingCommandItemCount}`,
      );
    }
    if (flags.mode === "dry-run") continue;

    try {
      const resolved = await dependencies.repository.resolveLegacyPhysicalPackage(
        candidate.representativeShipmentId,
      );
      const result = await dependencies.repository.materializePhysicalPackage({
        ...resolved,
        legacyWmsShipmentIds: [...resolved.legacyWmsShipmentIds],
        source: BACKFILL_SOURCE,
      });
      const counts = commandCounts(result);
      materialized += 1;
      commandsCreated += counts.created;
      commandsReplayed += counts.replayed;
    } catch (error: any) {
      reviewRequired += 1;
      const failure = Object.freeze({
        representativeShipmentId: candidate.representativeShipmentId,
        providerPhysicalShipmentId: candidate.providerPhysicalShipmentId,
        code: typeof error?.code === "string" ? error.code : "BACKFILL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
      failures.push(failure);
      if (!flags.json) log(`[Channel fulfillment authority backfill] REVIEW ${JSON.stringify(failure)}`);
    }
  }

  return Object.freeze({
    mode: flags.mode,
    candidates: candidates.length,
    materialized,
    commandsCreated,
    commandsReplayed,
    reviewRequired,
    failures: Object.freeze([...failures]),
  });
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const [{ db, pool }, { createChannelFulfillmentAuthorityRepository }] = await Promise.all([
    import("../server/db"),
    import("../server/modules/oms/channel-fulfillment-authority.repository"),
  ]);
  try {
    const summary = await runBackfill(flags, {
      repository: createChannelFulfillmentAuthorityRepository(db),
      loadCandidates: async (candidateFlags) => {
        const query = buildCandidateQuery(candidateFlags);
        const result = await pool.query(query.text, [...query.values]);
        return Object.freeze(result.rows.map(toCandidate));
      },
    });
    console.log(JSON.stringify(summary));
    if (summary.reviewRequired > 0) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isMain) {
  main().catch((error) => {
    console.error("[Channel fulfillment authority backfill] fatal:", error);
    process.exit(1);
  });
}
