/**
 * Repair historical OMS/WMS line authority from persisted Shopify refund facts.
 *
 * This script is intentionally narrow:
 * - Shopify refund line adjustment exists exactly once and is `no_restock`.
 * - The refund quantity equals the paid line quantity.
 * - Exactly one WMS order item maps to the OMS line.
 * - The historical WMS line is already cancelled with no picked/fulfilled
 *   quantity, or exact shipped package evidence can restore it canonically.
 * - Shipped evidence must exactly equal the paid line quantity and the Shopify
 *   order must already be fulfilled before canonical lineage is restored.
 *
 * Dry-run is the default. Execute requires an exact candidate count and
 * operator-supplied audit metadata.
 */

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ShopifyRefundLineAdjustment } from "../server/modules/oms/refund-line-disposition";

type Mode = "dry-run" | "execute";

export interface Flags {
  readonly help: boolean;
  readonly mode: Mode;
  readonly limit: number | null;
  readonly orderNumber: string | null;
  readonly confirmCount: number | null;
  readonly operator: string | null;
  readonly reason: string | null;
  readonly idempotencyKey: string | null;
  readonly json: boolean;
}

export interface RepairCandidate {
  readonly omsOrderId: number;
  readonly wmsOrderId: number;
  readonly externalOrderNumber: string;
  readonly refundExternalId: string;
  readonly adjustments: readonly ShopifyRefundLineAdjustment[];
  readonly legacyShipmentIds: readonly number[];
  readonly requiresPhysicalRestoration: boolean;
}

export interface RepairSummary {
  readonly mode: Mode;
  readonly runId: string;
  readonly candidates: number;
  readonly lines: number;
  readonly lineageValidated: number;
  readonly physicalPackagesProjected: number;
  readonly authorityChanges: number;
  readonly wmsLineChanges: number;
  readonly repaired: number;
  readonly reviewRequired: number;
  readonly failures: readonly Readonly<Record<string, unknown>>[];
}

export interface RepairDependencies {
  readonly loadCandidates: (flags: Flags) => Promise<readonly RepairCandidate[]>;
  readonly resolveLegacyShipment: (legacyShipmentId: number) => Promise<unknown>;
  readonly materializeAndProjectLegacyShipment: (legacyShipmentId: number) => Promise<void>;
  readonly reconcilePersistedRefund: (args: {
    candidate: RepairCandidate;
    runId: string;
    operator: string;
    reason: string;
    now: Date;
  }) => Promise<{ authorityChanges: number; wmsLineChanges: number }>;
  readonly now: () => Date;
  readonly log?: (message: string) => void;
}

const DEFAULT_LIMIT = 100;
const REPAIR_SOURCE = "script:historical-refund-authority-repair";

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function textFlag(argv: readonly string[], prefix: string): string | null {
  const raw = argv.find((arg) => arg.startsWith(prefix));
  if (!raw) return null;
  const value = raw.slice(prefix.length).trim();
  if (!value) throw new Error(`${prefix.slice(0, -1)} cannot be blank`);
  return value;
}

export function parseFlags(argv: readonly string[]): Flags {
  for (const arg of argv) {
    if (["--help", "-h", "--dry-run", "--execute", "--json"].includes(arg)) continue;
    if (
      /^--(limit|order-number|confirm-count|operator|reason|idempotency-key)=/.test(arg)
    ) {
      continue;
    }
    throw new Error(`Unknown flag: ${arg}`);
  }
  if (argv.includes("--dry-run") && argv.includes("--execute")) {
    throw new Error("Choose either --dry-run or --execute");
  }

  const limitValue = textFlag(argv, "--limit=") ?? String(DEFAULT_LIMIT);
  const limit = limitValue.toLowerCase() === "all"
    ? null
    : parsePositiveInteger(limitValue, "--limit");
  const confirmCountValue = textFlag(argv, "--confirm-count=");
  const flags: Flags = Object.freeze({
    help: argv.includes("--help") || argv.includes("-h"),
    mode: argv.includes("--execute") ? "execute" : "dry-run",
    limit,
    orderNumber: textFlag(argv, "--order-number="),
    confirmCount: confirmCountValue == null
      ? null
      : parsePositiveInteger(confirmCountValue, "--confirm-count"),
    operator: textFlag(argv, "--operator="),
    reason: textFlag(argv, "--reason="),
    idempotencyKey: textFlag(argv, "--idempotency-key="),
    json: argv.includes("--json"),
  });

  if (flags.mode === "execute") {
    for (const [name, value] of [
      ["--confirm-count", flags.confirmCount],
      ["--operator", flags.operator],
      ["--reason", flags.reason],
      ["--idempotency-key", flags.idempotencyKey],
    ] as const) {
      if (value == null) throw new Error(`${name} is required in execute mode`);
    }
  }
  return flags;
}

export function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/repair-persisted-shopify-refund-authority.ts --dry-run --limit=100",
    "  npx tsx scripts/repair-persisted-shopify-refund-authority.ts --execute --limit=100 --confirm-count=24 --operator=owner@cardshellz.com --reason=historical-refund-authority-repair --idempotency-key=refund-authority-repair-2026-07-26-batch-1",
    "",
    "Flags:",
    "  --dry-run                 Validate exact persisted refund and shipment lineage. Default.",
    "  --execute                 Apply the exact guarded selection.",
    "  --limit=N|all             Maximum refund-event candidates. Default 100.",
    "  --order-number=TEXT       Restrict to one channel order number.",
    "  --confirm-count=N         Required in execute mode; must match dry-run candidate count.",
    "  --operator=TEXT           Required in execute mode.",
    "  --reason=TEXT             Required in execute mode.",
    "  --idempotency-key=TEXT    Required in execute mode.",
    "  --json                    Print machine-readable summary only.",
  ].join("\n");
}

export function buildCandidateQuery(flags: Flags): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const orderFilter = flags.orderNumber == null
    ? ""
    : `AND oms_order.external_order_number = $${values.push(flags.orderNumber)}`;
  const limitClause = flags.limit == null
    ? ""
    : `LIMIT $${values.push(flags.limit)}`;

  return {
    text: `
      WITH materialized AS (
        SELECT
          item.oms_order_line_id,
          SUM(COALESCE(item.quantity, 0))::int AS actual_quantity
        FROM wms.order_items item
        WHERE item.oms_order_line_id IS NOT NULL
          AND COALESCE(item.status, '') <> 'cancelled'
        GROUP BY item.oms_order_line_id
      ),
      refund_fact AS (
        SELECT
          adjustment.order_id,
          adjustment.order_line_id,
          MIN(adjustment.source_event_id) AS refund_external_id,
          SUM(adjustment.quantity)::int AS refund_quantity,
          MIN(adjustment.restock_policy) AS restock_policy
        FROM oms.order_line_adjustments adjustment
        WHERE adjustment.source = 'shopify_webhook'
          AND adjustment.adjustment_type = 'refund'
        GROUP BY adjustment.order_id, adjustment.order_line_id
        HAVING COUNT(*) = 1
          AND COUNT(DISTINCT adjustment.source_event_id) = 1
          AND MIN(adjustment.restock_policy) = 'no_restock'
      ),
      wms_lineage AS (
        SELECT
          oms_line.id AS oms_order_line_id,
          COUNT(DISTINCT wms_order.id)::int AS wms_order_count,
          MIN(wms_order.id)::int AS wms_order_id,
          COUNT(DISTINCT wms_item.id)::int AS wms_item_count,
          MIN(wms_item.id)::int AS wms_item_id,
          MIN(wms_item.status) AS wms_item_status,
          COALESCE(SUM(wms_item.quantity), 0)::int AS wms_item_quantity,
          COALESCE(SUM(wms_item.picked_quantity), 0)::int AS picked_quantity,
          COALESCE(SUM(wms_item.fulfilled_quantity), 0)::int AS fulfilled_quantity
        FROM oms.oms_order_lines oms_line
        LEFT JOIN wms.orders wms_order
          ON (
            wms_order.source = 'oms'
            AND wms_order.oms_fulfillment_order_id = oms_line.order_id::text
          )
          OR (
            wms_order.source = 'shopify'
            AND wms_order.source_table_id = oms_line.order_id::text
          )
        LEFT JOIN wms.order_items wms_item
          ON wms_item.order_id = wms_order.id
         AND wms_item.oms_order_line_id = oms_line.id
        GROUP BY oms_line.id
      ),
      legacy_shipping AS (
        SELECT
          wms_item.oms_order_line_id,
          COALESCE(SUM(shipment_item.qty) FILTER (
            WHERE shipment.status = 'shipped'
              AND shipment.shipment_purpose = 'customer_fulfillment'
              AND shipment_item.shipment_item_purpose = 'customer_fulfillment'
          ), 0)::int AS shipped_quantity,
          ARRAY_AGG(DISTINCT shipment.id ORDER BY shipment.id) FILTER (
            WHERE shipment.status = 'shipped'
              AND shipment.shipment_purpose = 'customer_fulfillment'
              AND shipment_item.shipment_item_purpose = 'customer_fulfillment'
          ) AS legacy_shipment_ids
        FROM wms.order_items wms_item
        LEFT JOIN wms.outbound_shipment_items shipment_item
          ON shipment_item.order_item_id = wms_item.id
        LEFT JOIN wms.outbound_shipments shipment
          ON shipment.id = shipment_item.shipment_id
        WHERE wms_item.oms_order_line_id IS NOT NULL
        GROUP BY wms_item.oms_order_line_id
      ),
      canonical_shipping AS (
        SELECT
          plan_line.oms_order_line_id,
          COALESCE(SUM(physical_item.quantity_shipped) FILTER (
            WHERE physical.status = 'shipped'
              AND physical_item.shipment_item_purpose = 'customer_fulfillment'
          ), 0)::int AS shipped_quantity
        FROM wms.fulfillment_plan_lines plan_line
        LEFT JOIN wms.physical_shipment_items physical_item
          ON physical_item.fulfillment_plan_line_id = plan_line.id
        LEFT JOIN wms.physical_shipments physical
          ON physical.id = physical_item.physical_shipment_id
        GROUP BY plan_line.oms_order_line_id
      ),
      eligible_line AS (
        SELECT
          oms_order.id::bigint AS oms_order_id,
          lineage.wms_order_id,
          COALESCE(oms_order.external_order_number, oms_order.external_order_id) AS external_order_number,
          refund.refund_external_id,
          oms_line.id::bigint AS oms_order_line_id,
          oms_line.external_line_item_id,
          refund.refund_quantity,
          refund.restock_policy,
          COALESCE(legacy.shipped_quantity, 0)::int AS legacy_shipped_quantity,
          COALESCE(legacy.legacy_shipment_ids, ARRAY[]::int[]) AS legacy_shipment_ids,
          CASE
            WHEN lineage.wms_item_status = 'cancelled'
              AND COALESCE(legacy.shipped_quantity, 0) > 0
              THEN true
            ELSE false
          END AS requires_physical_restoration
        FROM oms.oms_order_lines oms_line
        JOIN oms.oms_orders oms_order ON oms_order.id = oms_line.order_id
        JOIN channels.channels channel ON channel.id = oms_order.channel_id
        JOIN refund_fact refund
          ON refund.order_id = oms_line.order_id
         AND refund.order_line_id = oms_line.id
        JOIN wms_lineage lineage ON lineage.oms_order_line_id = oms_line.id
        LEFT JOIN materialized ON materialized.oms_order_line_id = oms_line.id
        LEFT JOIN legacy_shipping legacy ON legacy.oms_order_line_id = oms_line.id
        LEFT JOIN canonical_shipping canonical ON canonical.oms_order_line_id = oms_line.id
        WHERE LOWER(channel.provider) = 'shopify'
          ${orderFilter}
          AND COALESCE(oms_line.authority_fulfillable_quantity, 0) > 0
          AND COALESCE(oms_line.refunded_quantity, 0) = 0
          AND refund.refund_quantity = oms_line.paid_quantity
          AND lineage.wms_order_count = 1
          AND lineage.wms_item_count = 1
          AND lineage.wms_item_quantity = oms_line.paid_quantity
          AND (
            (
              oms_order.status = 'cancelled'
              AND lineage.wms_item_status = 'cancelled'
              AND lineage.picked_quantity = 0
              AND lineage.fulfilled_quantity = 0
              AND COALESCE(materialized.actual_quantity, 0) = 0
              AND COALESCE(oms_line.wms_materialized_quantity, 0)
                > COALESCE(materialized.actual_quantity, 0)
              AND COALESCE(legacy.shipped_quantity, 0) = 0
              AND COALESCE(canonical.shipped_quantity, 0) = 0
            )
            OR (
              oms_order.status = 'shipped'
              AND oms_order.fulfillment_status = 'fulfilled'
              AND COALESCE(legacy.shipped_quantity, 0) = oms_line.paid_quantity
              AND CARDINALITY(COALESCE(legacy.legacy_shipment_ids, ARRAY[]::int[])) > 0
              AND (
                (
                  lineage.wms_item_status = 'cancelled'
                  AND lineage.picked_quantity = 0
                  AND lineage.fulfilled_quantity = 0
                  AND COALESCE(materialized.actual_quantity, 0) = 0
                  AND COALESCE(oms_line.wms_materialized_quantity, 0)
                    > COALESCE(materialized.actual_quantity, 0)
                  AND COALESCE(canonical.shipped_quantity, 0)
                    IN (0, oms_line.paid_quantity)
                )
                OR (
                  lineage.wms_item_status = 'completed'
                  AND lineage.picked_quantity >= oms_line.paid_quantity
                  AND lineage.fulfilled_quantity = oms_line.paid_quantity
                  AND COALESCE(materialized.actual_quantity, 0) = oms_line.paid_quantity
                  AND COALESCE(canonical.shipped_quantity, 0) = oms_line.paid_quantity
                )
              )
            )
          )
      )
      SELECT
        eligible.oms_order_id,
        eligible.wms_order_id,
        eligible.external_order_number,
        eligible.refund_external_id,
        BOOL_OR(eligible.requires_physical_restoration) AS requires_physical_restoration,
        ARRAY(
          SELECT DISTINCT shipment_id
          FROM eligible_line nested
          CROSS JOIN LATERAL UNNEST(nested.legacy_shipment_ids) AS shipment(shipment_id)
          WHERE nested.oms_order_id = eligible.oms_order_id
            AND nested.refund_external_id = eligible.refund_external_id
            AND nested.requires_physical_restoration = true
          ORDER BY shipment_id
        ) AS legacy_shipment_ids,
        JSONB_AGG(
          JSONB_BUILD_OBJECT(
            'externalLineItemId', eligible.external_line_item_id,
            'quantity', eligible.refund_quantity,
            'restockPolicy', eligible.restock_policy,
            'raw', JSONB_BUILD_OBJECT(
              'source', 'persisted_shopify_refund_adjustment',
              'omsOrderLineId', eligible.oms_order_line_id
            )
          )
          ORDER BY eligible.oms_order_line_id
        ) AS adjustments
      FROM eligible_line eligible
      GROUP BY
        eligible.oms_order_id,
        eligible.wms_order_id,
        eligible.external_order_number,
        eligible.refund_external_id
      ORDER BY eligible.oms_order_id, eligible.refund_external_id
      ${limitClause}
    `,
    values,
  };
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

export function toCandidate(row: any): RepairCandidate {
  const adjustments = Array.isArray(row.adjustments)
    ? row.adjustments.map((adjustment: any) => {
      const externalLineItemId = String(adjustment.externalLineItemId ?? "").trim();
      if (!externalLineItemId) throw new Error("adjustment.externalLineItemId cannot be blank");
      if (adjustment.restockPolicy !== "no_restock") {
        throw new Error("historical refund authority repair only accepts no_restock adjustments");
      }
      return Object.freeze({
        externalLineItemId,
        quantity: positiveInteger(adjustment.quantity, "adjustment.quantity"),
        restockPolicy: "no_restock" as const,
        raw: adjustment.raw && typeof adjustment.raw === "object" ? adjustment.raw : {},
      });
    })
    : [];
  if (adjustments.length === 0) throw new Error("candidate adjustments cannot be empty");

  const legacyShipmentIds = Object.freeze(
    (row.legacy_shipment_ids ?? []).map((id: unknown) =>
      positiveInteger(id, "legacy_shipment_id")),
  );
  const requiresPhysicalRestoration = row.requires_physical_restoration === true;
  if (requiresPhysicalRestoration !== (legacyShipmentIds.length > 0)) {
    throw new Error(
      "candidate physical restoration flag must agree with legacy shipment lineage",
    );
  }

  return Object.freeze({
    omsOrderId: positiveInteger(row.oms_order_id, "oms_order_id"),
    wmsOrderId: positiveInteger(row.wms_order_id, "wms_order_id"),
    externalOrderNumber: String(row.external_order_number),
    refundExternalId: String(row.refund_external_id),
    adjustments: Object.freeze(adjustments),
    legacyShipmentIds,
    requiresPhysicalRestoration,
  });
}

export function runIdFromIdempotencyKey(idempotencyKey: string): string {
  const hash = crypto.createHash("sha256").update(idempotencyKey).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

export async function runRepair(
  flags: Flags,
  dependencies: RepairDependencies,
): Promise<RepairSummary> {
  const log = dependencies.log ?? console.log;
  const candidates = await dependencies.loadCandidates(flags);
  if (flags.mode === "execute" && flags.confirmCount !== candidates.length) {
    throw new Error(
      `--confirm-count=${flags.confirmCount} does not match selected dry-run count ${candidates.length}`,
    );
  }
  const runId = flags.idempotencyKey == null
    ? crypto.randomUUID()
    : runIdFromIdempotencyKey(flags.idempotencyKey);
  let lineageValidated = 0;
  let physicalPackagesProjected = 0;
  let authorityChanges = 0;
  let wmsLineChanges = 0;
  let repaired = 0;
  let reviewRequired = 0;
  const failures: Array<Readonly<Record<string, unknown>>> = [];

  if (!flags.json) {
    log(
      `[Historical refund authority repair] mode=${flags.mode} candidates=${candidates.length} `
      + `lines=${candidates.reduce((sum, candidate) => sum + candidate.adjustments.length, 0)} `
      + `limit=${flags.limit ?? "all"}`,
    );
  }

  for (const candidate of candidates) {
    try {
      for (const shipmentId of candidate.legacyShipmentIds) {
        await dependencies.resolveLegacyShipment(shipmentId);
        lineageValidated++;
      }
      if (!flags.json) {
        log(
          `[Historical refund authority repair] ${flags.mode === "execute" ? "REPAIR" : "PLAN"} `
          + `order=${candidate.externalOrderNumber} oms=${candidate.omsOrderId} `
          + `refund=${candidate.refundExternalId} lines=${candidate.adjustments.length} `
          + `restoreShipments=${candidate.legacyShipmentIds.join(",") || "none"}`,
        );
      }
      if (flags.mode === "dry-run") continue;

      for (const shipmentId of candidate.legacyShipmentIds) {
        await dependencies.materializeAndProjectLegacyShipment(shipmentId);
        physicalPackagesProjected++;
      }
      const result = await dependencies.reconcilePersistedRefund({
        candidate,
        runId,
        operator: flags.operator!,
        reason: flags.reason!,
        now: dependencies.now(),
      });
      authorityChanges += result.authorityChanges;
      wmsLineChanges += result.wmsLineChanges;
      repaired++;
    } catch (error: any) {
      reviewRequired++;
      const failure = Object.freeze({
        omsOrderId: candidate.omsOrderId,
        externalOrderNumber: candidate.externalOrderNumber,
        refundExternalId: candidate.refundExternalId,
        code: typeof error?.code === "string" ? error.code : "HISTORICAL_REFUND_REPAIR_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
      failures.push(failure);
      if (!flags.json) {
        log(`[Historical refund authority repair] REVIEW ${JSON.stringify(failure)}`);
      }
    }
  }

  return Object.freeze({
    mode: flags.mode,
    runId,
    candidates: candidates.length,
    lines: candidates.reduce((sum, candidate) => sum + candidate.adjustments.length, 0),
    lineageValidated,
    physicalPackagesProjected,
    authorityChanges,
    wmsLineChanges,
    repaired,
    reviewRequired,
    failures: Object.freeze(failures),
  });
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const [
    databaseModule,
    repositoryModule,
    projectionModule,
    refundModule,
  ] = await Promise.all([
    import("../server/db"),
    import("../server/modules/oms/channel-fulfillment-authority.repository"),
    import("../server/modules/oms/channel-fulfillment-projection.repository"),
    import("../server/modules/oms/shopify-refund-cascade.service"),
  ]);
  const repository = repositoryModule.createChannelFulfillmentAuthorityRepository(
    databaseModule.db,
  );
  const projector = projectionModule.createChannelFulfillmentProjector(databaseModule.db);

  try {
    const summary = await runRepair(flags, {
      loadCandidates: async (candidateFlags) => {
        const query = buildCandidateQuery(candidateFlags);
        const result = await databaseModule.pool.query(query.text, query.values);
        return Object.freeze(result.rows.map(toCandidate));
      },
      resolveLegacyShipment: (shipmentId) =>
        repository.resolveLegacyPhysicalPackage(shipmentId),
      materializeAndProjectLegacyShipment: async (shipmentId) => {
        const resolved = await repository.resolveLegacyPhysicalPackage(shipmentId);
        const materialized = await repository.materializePhysicalPackage({
          ...resolved,
          legacyWmsShipmentIds: [...resolved.legacyWmsShipmentIds],
          source: REPAIR_SOURCE,
          suppressChannelProviders: ["shopify"],
        });
        await projector.projectPhysicalShipment(materialized.physicalShipmentId);
      },
      reconcilePersistedRefund: async ({ candidate, runId, operator, reason, now }) =>
        refundModule.reconcilePersistedShopifyRefundAuthority(databaseModule.db, {
          omsOrderId: candidate.omsOrderId,
          wmsOrderId: candidate.wmsOrderId,
          refundExternalId: candidate.refundExternalId,
          adjustments: candidate.adjustments,
          sourceInboxId: null,
          now,
          audit: { runId, operator, reason },
        }),
      now: () => new Date(),
    });
    console.log(JSON.stringify(summary));
    if (summary.reviewRequired > 0) process.exitCode = 2;
  } finally {
    await databaseModule.pool.end();
  }
}

const isMain = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isMain) {
  main().catch((error) => {
    console.error("[Historical refund authority repair] fatal:", error);
    process.exitCode = 1;
  });
}
