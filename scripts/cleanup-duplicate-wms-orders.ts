/**
 * Classify and retire duplicate OMS-backed WMS orders.
 *
 * Defaults to dry-run. The script never deletes rows. Safe duplicate rows are
 * retired by marking the duplicate WMS order cancelled, cancelling any unpushed
 * shipment rows, and writing an OMS audit event.
 *
 * Usage:
 *   npx tsx scripts/cleanup-duplicate-wms-orders.ts --dry-run --limit=25
 *   npx tsx scripts/cleanup-duplicate-wms-orders.ts --execute --order-number=#57785 --cancel-shipstation
 *   npx tsx scripts/cleanup-duplicate-wms-orders.ts --execute --oms-order-id=184362
 */

import fs from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";

type Mode = "dry-run" | "execute";

interface Flags {
  mode: Mode;
  limit: number;
  omsOrderId: number | null;
  orderNumber: string | null;
  cancelShipStation: boolean;
  help: boolean;
}

interface ShipmentSummary {
  id: number;
  status: string;
  shipstation_order_id: number | null;
  shipstation_order_key: string | null;
  tracking_number: string | null;
  requires_review: boolean;
}

interface DuplicateWmsOrder {
  oms_order_id: number;
  external_order_number: string | null;
  oms_status: string | null;
  oms_fulfillment_status: string | null;
  wms_order_id: number;
  order_number: string;
  warehouse_id: number | null;
  warehouse_status: string;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  completed_at: string | null;
  tracking_number: string | null;
  item_count: number;
  unit_quantity: number;
  picked_quantity: number;
  fulfilled_quantity: number;
  item_signature: string | null;
  shipment_count: number;
  active_shipment_count: number;
  active_shipstation_count: number;
  shipped_shipment_count: number;
  shipments: ShipmentSummary[];
}

interface GroupPlan {
  omsOrderId: number;
  orderNumber: string;
  canonical: DuplicateWmsOrder;
  rows: DuplicateWmsOrder[];
  decisions: RowDecision[];
}

type RowAction =
  | "keep"
  | "already_retired"
  | "retire_db_only"
  | "retire_after_shipstation_cancel"
  | "needs_shipstation_cancel"
  | "manual_review";

interface RowDecision {
  row: DuplicateWmsOrder;
  action: RowAction;
  reason: string;
  shipstationOrderIds: number[];
}

const ACTIVE_SHIPMENT_STATUSES = new Set(["planned", "queued", "labeled", "on_hold"]);
const SAFE_DB_CANCEL_SHIPMENT_STATUSES = new Set(["planned", "queued", "labeled", "on_hold", "cancelled", "voided"]);

export function parseFlags(argv: string[]): Flags {
  const help = argv.includes("--help") || argv.includes("-h");
  const execute = argv.includes("--execute");
  const dryRun = argv.includes("--dry-run");
  if (execute && dryRun) {
    throw new Error("Cannot pass both --execute and --dry-run");
  }

  const readInt = (name: string, fallback: number): number => {
    const arg = argv.find((value) => value.startsWith(`--${name}=`));
    if (!arg) return fallback;
    const parsed = Number(arg.slice(name.length + 3));
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`--${name} must be a positive integer`);
    }
    return parsed;
  };

  const omsArg = argv.find((value) => value.startsWith("--oms-order-id="));
  const omsOrderId = omsArg ? Number(omsArg.slice("--oms-order-id=".length)) : null;
  if (omsOrderId !== null && (!Number.isInteger(omsOrderId) || omsOrderId <= 0)) {
    throw new Error("--oms-order-id must be a positive integer");
  }

  const orderNumberArg = argv.find((value) => value.startsWith("--order-number="));
  const orderNumber = orderNumberArg ? orderNumberArg.slice("--order-number=".length).trim() : null;
  if (orderNumber !== null && orderNumber.length === 0) {
    throw new Error("--order-number cannot be blank");
  }

  return {
    help,
    mode: execute ? "execute" : "dry-run",
    limit: readInt("limit", omsOrderId || orderNumber ? 1 : 25),
    omsOrderId,
    orderNumber,
    cancelShipStation: argv.includes("--cancel-shipstation"),
  };
}

function printHelp(): void {
  console.log(`
Usage:
  npx tsx scripts/cleanup-duplicate-wms-orders.ts --dry-run --limit=25
  npx tsx scripts/cleanup-duplicate-wms-orders.ts --execute --oms-order-id=184362
  npx tsx scripts/cleanup-duplicate-wms-orders.ts --execute --order-number=#57785 --cancel-shipstation

Flags:
  --dry-run              Classify only. Default.
  --execute              Retire safe duplicate rows.
  --limit=N              Max duplicate groups to inspect. Default 25.
  --oms-order-id=N       Restrict to one OMS order id.
  --order-number=#NNNNN  Restrict to one order number.
  --cancel-shipstation   Allow the script to cancel active duplicate ShipStation orders.

Safety:
  - Never deletes WMS rows.
  - Refuses rows with different item coverage.
  - Refuses rows with shipped/tracking evidence.
  - Refuses active ShipStation duplicates unless --cancel-shipstation is passed.
`);
}

function loadDotenvIfAvailable(): void {
  if (process.env.DATABASE_URL) return;
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
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function rowsFromJson<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
      return [];
    }
  }
  return [];
}

function asInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasShippedEvidence(row: DuplicateWmsOrder): boolean {
  return (
    row.shipped_shipment_count > 0 ||
    Boolean(row.tracking_number) ||
    row.shipments.some((shipment) => Boolean(shipment.tracking_number))
  );
}

function scoreCanonical(row: DuplicateWmsOrder): number {
  let score = 0;
  if (hasShippedEvidence(row)) score += 100_000;
  score += row.fulfilled_quantity * 1_000;
  score += row.picked_quantity * 500;
  if (row.active_shipstation_count > 0) score += 100;
  score += row.shipment_count * 10;
  if (row.warehouse_status === "cancelled") score -= 1_000;
  return score;
}

export function chooseCanonical(rows: DuplicateWmsOrder[]): DuplicateWmsOrder {
  return [...rows].sort((a, b) => {
    const scoreDelta = scoreCanonical(b) - scoreCanonical(a);
    if (scoreDelta !== 0) return scoreDelta;
    return a.wms_order_id - b.wms_order_id;
  })[0];
}

function activeShipStationOrderIds(row: DuplicateWmsOrder): number[] {
  return [
    ...new Set(
      row.shipments
        .filter((shipment) => ACTIVE_SHIPMENT_STATUSES.has(shipment.status))
        .map((shipment) => shipment.shipstation_order_id)
        .filter((value): value is number => Number.isInteger(value) && value > 0),
    ),
  ];
}

function canDbRetire(row: DuplicateWmsOrder): boolean {
  if (hasShippedEvidence(row)) return false;
  if (row.picked_quantity > 0 || row.fulfilled_quantity > 0) return false;
  return row.shipments.every((shipment) => SAFE_DB_CANCEL_SHIPMENT_STATUSES.has(shipment.status));
}

export function decideRow(row: DuplicateWmsOrder, canonical: DuplicateWmsOrder, flags: Flags): RowDecision {
  if (row.wms_order_id === canonical.wms_order_id) {
    return { row, action: "keep", reason: "canonical WMS order", shipstationOrderIds: [] };
  }

  if (row.warehouse_status === "cancelled" && row.active_shipment_count === 0) {
    return { row, action: "already_retired", reason: "duplicate already cancelled", shipstationOrderIds: [] };
  }

  if ((row.item_signature ?? "") !== (canonical.item_signature ?? "")) {
    return {
      row,
      action: "manual_review",
      reason: "item coverage differs from canonical row",
      shipstationOrderIds: activeShipStationOrderIds(row),
    };
  }

  if (hasShippedEvidence(row)) {
    return {
      row,
      action: "manual_review",
      reason: "duplicate has shipped/tracking evidence",
      shipstationOrderIds: activeShipStationOrderIds(row),
    };
  }

  if (row.picked_quantity > 0 || row.fulfilled_quantity > 0) {
    return {
      row,
      action: "manual_review",
      reason: "duplicate has picked or fulfilled quantities",
      shipstationOrderIds: activeShipStationOrderIds(row),
    };
  }

  const shipstationOrderIds = activeShipStationOrderIds(row);
  if (shipstationOrderIds.length > 0) {
    return flags.cancelShipStation
      ? {
          row,
          action: "retire_after_shipstation_cancel",
          reason: "duplicate has active ShipStation order(s), cancellation allowed",
          shipstationOrderIds,
        }
      : {
          row,
          action: "needs_shipstation_cancel",
          reason: "duplicate has active ShipStation order(s); rerun with --cancel-shipstation to cancel them",
          shipstationOrderIds,
        };
  }

  if (canDbRetire(row)) {
    return { row, action: "retire_db_only", reason: "no shipped evidence, no picks, no active ShipStation order", shipstationOrderIds: [] };
  }

  return {
    row,
    action: "manual_review",
    reason: "shipment state is not safe for automatic retirement",
    shipstationOrderIds,
  };
}

async function fetchDuplicateRows(client: PoolClient, flags: Flags): Promise<DuplicateWmsOrder[]> {
  const params: unknown[] = [];
  const filters = [
    "wo.source = 'oms'",
    "NULLIF(wo.oms_fulfillment_order_id, '') IS NOT NULL",
  ];

  if (flags.omsOrderId !== null) {
    params.push(String(flags.omsOrderId));
    filters.push(`wo.oms_fulfillment_order_id = $${params.length}`);
  }

  if (flags.orderNumber !== null) {
    params.push(flags.orderNumber);
    filters.push(`(wo.order_number = $${params.length} OR oo.external_order_number = $${params.length})`);
  }

  params.push(flags.limit);
  const limitParam = `$${params.length}`;

  const result = await client.query(`
    WITH duplicate_keys AS (
      SELECT wo.oms_fulfillment_order_id
      FROM wms.orders wo
      LEFT JOIN oms.oms_orders oo ON oo.id::text = wo.oms_fulfillment_order_id
      WHERE ${filters.join(" AND ")}
      GROUP BY wo.oms_fulfillment_order_id
      HAVING COUNT(*) > 1
      ORDER BY MIN(wo.created_at), MIN(wo.id)
      LIMIT ${limitParam}
    )
    SELECT
      oo.id::int AS oms_order_id,
      oo.external_order_number,
      oo.status AS oms_status,
      oo.fulfillment_status AS oms_fulfillment_status,
      wo.id::int AS wms_order_id,
      wo.order_number,
      wo.warehouse_id,
      wo.warehouse_status,
      wo.created_at::text,
      wo.updated_at::text,
      wo.cancelled_at::text,
      wo.completed_at::text,
      wo.tracking_number,
      COALESCE(items.item_count, 0)::int AS item_count,
      COALESCE(items.unit_quantity, 0)::int AS unit_quantity,
      COALESCE(items.picked_quantity, 0)::int AS picked_quantity,
      COALESCE(items.fulfilled_quantity, 0)::int AS fulfilled_quantity,
      items.item_signature,
      COALESCE(shipments.shipment_count, 0)::int AS shipment_count,
      COALESCE(shipments.active_shipment_count, 0)::int AS active_shipment_count,
      COALESCE(shipments.active_shipstation_count, 0)::int AS active_shipstation_count,
      COALESCE(shipments.shipped_shipment_count, 0)::int AS shipped_shipment_count,
      COALESCE(shipments.shipments, '[]'::jsonb) AS shipments
    FROM duplicate_keys dk
    JOIN wms.orders wo
      ON wo.source = 'oms'
     AND wo.oms_fulfillment_order_id = dk.oms_fulfillment_order_id
    LEFT JOIN oms.oms_orders oo
      ON oo.id::text = wo.oms_fulfillment_order_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS item_count,
        COALESCE(SUM(oi.quantity), 0) AS unit_quantity,
        COALESCE(SUM(oi.picked_quantity), 0) AS picked_quantity,
        COALESCE(SUM(oi.fulfilled_quantity), 0) AS fulfilled_quantity,
        STRING_AGG(
          CONCAT(
            COALESCE(oi.oms_order_line_id::text, oi.source_item_id, oi.sku),
            '=',
            oi.quantity
          ),
          '|'
          ORDER BY COALESCE(oi.oms_order_line_id::text, oi.source_item_id, oi.sku)
        ) AS item_signature
      FROM wms.order_items oi
      WHERE oi.order_id = wo.id
    ) items ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(os.id) AS shipment_count,
        COUNT(os.id) FILTER (WHERE os.status IN ('planned', 'queued', 'labeled', 'on_hold')) AS active_shipment_count,
        COUNT(os.id) FILTER (
          WHERE os.status IN ('planned', 'queued', 'labeled', 'on_hold')
            AND os.shipstation_order_id IS NOT NULL
        ) AS active_shipstation_count,
        COUNT(os.id) FILTER (WHERE os.status = 'shipped') AS shipped_shipment_count,
        JSONB_AGG(
          JSONB_BUILD_OBJECT(
            'id', os.id,
            'status', os.status,
            'shipstation_order_id', os.shipstation_order_id,
            'shipstation_order_key', os.shipstation_order_key,
            'tracking_number', os.tracking_number,
            'requires_review', os.requires_review
          )
          ORDER BY os.id
        ) FILTER (WHERE os.id IS NOT NULL) AS shipments
      FROM wms.outbound_shipments os
      WHERE os.order_id = wo.id
    ) shipments ON true
    ORDER BY oo.id, wo.id
  `, params);

  return result.rows.map((row) => ({
    ...row,
    oms_order_id: asInt(row.oms_order_id),
    wms_order_id: asInt(row.wms_order_id),
    warehouse_id: row.warehouse_id === null ? null : asInt(row.warehouse_id),
    item_count: asInt(row.item_count),
    unit_quantity: asInt(row.unit_quantity),
    picked_quantity: asInt(row.picked_quantity),
    fulfilled_quantity: asInt(row.fulfilled_quantity),
    shipment_count: asInt(row.shipment_count),
    active_shipment_count: asInt(row.active_shipment_count),
    active_shipstation_count: asInt(row.active_shipstation_count),
    shipped_shipment_count: asInt(row.shipped_shipment_count),
    shipments: rowsFromJson<ShipmentSummary>(row.shipments),
  }));
}

export function buildPlans(rows: DuplicateWmsOrder[], flags: Flags): GroupPlan[] {
  const groups = new Map<number, DuplicateWmsOrder[]>();
  for (const row of rows) {
    const groupRows = groups.get(row.oms_order_id) ?? [];
    groupRows.push(row);
    groups.set(row.oms_order_id, groupRows);
  }

  return [...groups.entries()].map(([omsOrderId, groupRows]) => {
    const canonical = chooseCanonical(groupRows);
    return {
      omsOrderId,
      orderNumber: canonical.external_order_number || canonical.order_number,
      canonical,
      rows: groupRows,
      decisions: groupRows.map((row) => decideRow(row, canonical, flags)),
    };
  });
}

function printPlan(plans: GroupPlan[], flags: Flags): void {
  console.log(`[WMS duplicate cleanup] mode=${flags.mode} groups=${plans.length} limit=${flags.limit} cancelShipStation=${flags.cancelShipStation}`);

  for (const plan of plans) {
    console.log(`GROUP oms=${plan.omsOrderId} order=${plan.orderNumber} canonical=${plan.canonical.wms_order_id} rows=${plan.rows.length}`);
    for (const decision of plan.decisions) {
      const row = decision.row;
      const ss = decision.shipstationOrderIds.length > 0
        ? ` ss=[${decision.shipstationOrderIds.join(",")}]`
        : "";
      console.log(
        `  ${decision.action.toUpperCase()} wms=${row.wms_order_id} status=${row.warehouse_status}` +
          ` items=${row.item_count}/${row.unit_quantity} picked=${row.picked_quantity} fulfilled=${row.fulfilled_quantity}` +
          ` shipments=${row.shipment_count} activeSS=${row.active_shipstation_count}${ss} reason="${decision.reason}"`,
      );
    }
  }
}

async function shipStationRequest<T>(method: string, pathName: string, body?: unknown): Promise<T> {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  const apiSecret = process.env.SHIPSTATION_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("SHIPSTATION_API_KEY and SHIPSTATION_API_SECRET must be set when using --cancel-shipstation");
  }

  const response = await fetch(`https://ssapi.shipstation.com${pathName}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ShipStation API ${method} ${pathName} failed (${response.status}): ${text}`);
  }

  return await response.json() as T;
}

async function cancelShipStationOrder(shipstationOrderId: number): Promise<void> {
  const existing: any = await shipStationRequest("GET", `/orders/${shipstationOrderId}`);
  if (existing.orderStatus === "cancelled") return;
  if (existing.orderStatus === "shipped") {
    throw new Error(`ShipStation order ${shipstationOrderId} is already shipped; refusing to cancel`);
  }
  await shipStationRequest("POST", "/orders/createorder", {
    ...existing,
    orderStatus: "cancelled",
  });
}

async function retireDuplicate(client: PoolClient, plan: GroupPlan, decision: RowDecision, flags: Flags): Promise<void> {
  const row = decision.row;

  if (decision.action === "retire_after_shipstation_cancel") {
    for (const shipstationOrderId of decision.shipstationOrderIds) {
      await cancelShipStationOrder(shipstationOrderId);
    }
  }

  await client.query("BEGIN");
  try {
    await client.query(`
      UPDATE wms.outbound_shipments
      SET status = CASE
            WHEN status IN ('planned', 'queued', 'labeled', 'on_hold') THEN 'cancelled'
            ELSE status
          END,
          cancelled_at = CASE
            WHEN status IN ('planned', 'queued', 'labeled', 'on_hold') THEN COALESCE(cancelled_at, NOW())
            ELSE cancelled_at
          END,
          updated_at = NOW()
      WHERE order_id = $1
        AND status IN ('planned', 'queued', 'labeled', 'on_hold')
    `, [row.wms_order_id]);

    await client.query(`
      UPDATE wms.order_items
      SET status = 'cancelled'
      WHERE order_id = $1
        AND COALESCE(picked_quantity, 0) = 0
        AND COALESCE(fulfilled_quantity, 0) = 0
        AND status NOT IN ('completed', 'cancelled')
    `, [row.wms_order_id]);

    await client.query(`
      UPDATE wms.orders
      SET warehouse_status = 'cancelled',
          cancelled_at = COALESCE(cancelled_at, NOW()),
          short_reason = $2::text,
          notes = CONCAT_WS(E'\n', NULLIF(notes, ''), $3::text),
          updated_at = NOW()
      WHERE id = $1
    `, [
      row.wms_order_id,
      `duplicate WMS order retired; canonical=${plan.canonical.wms_order_id}`,
      `Duplicate WMS cleanup: retired in favor of canonical WMS order ${plan.canonical.wms_order_id}. Reason: ${decision.reason}.`,
    ]);

    await client.query(`
      INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
      VALUES ($1, 'wms_duplicate_cleanup', $2::jsonb, NOW())
    `, [
      plan.omsOrderId,
      JSON.stringify({
        duplicateWmsOrderId: row.wms_order_id,
        canonicalWmsOrderId: plan.canonical.wms_order_id,
        action: decision.action,
        reason: decision.reason,
        cancelledShipstationOrderIds: decision.shipstationOrderIds,
        operator: "script:cleanup-duplicate-wms-orders",
        mode: flags.mode,
      }),
    ]);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function executePlans(client: PoolClient, plans: GroupPlan[], flags: Flags): Promise<Record<string, number>> {
  const summary: Record<string, number> = {
    retired: 0,
    alreadyRetired: 0,
    needsShipstationCancel: 0,
    manualReview: 0,
    kept: 0,
  };

  for (const plan of plans) {
    for (const decision of plan.decisions) {
      if (decision.action === "keep") {
        summary.kept++;
        continue;
      }
      if (decision.action === "already_retired") {
        summary.alreadyRetired++;
        continue;
      }
      if (decision.action === "needs_shipstation_cancel") {
        summary.needsShipstationCancel++;
        continue;
      }
      if (decision.action === "manual_review") {
        summary.manualReview++;
        continue;
      }
      if (decision.action === "retire_db_only" || decision.action === "retire_after_shipstation_cancel") {
        if (flags.mode === "execute") {
          await retireDuplicate(client, plan, decision, flags);
        }
        summary.retired++;
      }
    }
  }

  return summary;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const flags = parseFlags(argv);
  if (flags.help) {
    printHelp();
    return;
  }

  loadDotenvIfAvailable();
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("localhost")
      ? undefined
      : { rejectUnauthorized: false },
  });

  const client = await pool.connect();
  try {
    const rows = await fetchDuplicateRows(client, flags);
    const plans = buildPlans(rows, flags);
    printPlan(plans, flags);
    const summary = await executePlans(client, plans, flags);
    console.log(`[WMS duplicate cleanup] complete ${JSON.stringify(summary)}`);
  } finally {
    client.release();
    await pool.end();
  }
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((error) => {
    console.error(`[WMS duplicate cleanup] fatal: ${error?.stack || error}`);
    process.exit(1);
  });
}
