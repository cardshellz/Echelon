/**
 * Backfill active WMS SLA due dates and sort ranks after SLA settings changes.
 *
 * Default is dry-run.
 *
 * Examples:
 *   npx tsx scripts/backfill-active-wms-sla-ranks.ts --dry-run --limit=25
 *   npx tsx scripts/backfill-active-wms-sla-ranks.ts --execute --push-shipstation
 *   npx tsx scripts/backfill-active-wms-sla-ranks.ts --execute --order-number=#57954 --push-shipstation
 */

import { fileURLToPath } from "node:url";
import { db } from "../server/db";
import { sql } from "drizzle-orm";
import { computeSortRank, resolveSlaDueAt } from "../server/modules/orders/sort-rank";
import { createShipStationService } from "../server/modules/oms/shipstation.service";
import { extractEbayShipByDate } from "../server/modules/oms/ebay-shipby";

type Mode = "dry-run" | "execute";

interface Flags {
  mode: Mode;
  limit: number | null;
  orderNumber: string | null;
  wmsOrderId: number | null;
  pushShipStation: boolean;
  help: boolean;
}

interface ActiveWmsOrderRow {
  id: number;
  order_number: string;
  channel_id: number | null;
  channel_provider: string | null;
  oms_order_id: number | null;
  oms_channel_ship_by_date: Date | string | null;
  oms_raw_payload: unknown;
  priority: number | null;
  on_hold: number | null;
  channel_ship_by_date: Date | string | null;
  sla_due_at: Date | string | null;
  sort_rank: string | null;
  order_placed_at: Date | string | null;
  created_at: Date | string | null;
}

interface PlannedUpdate {
  row: ActiveWmsOrderRow;
  nextChannelShipByDate: Date | null;
  nextSlaDueAt: Date | null;
  nextSortRank: string;
  nextSlaStatus: string | null;
  changed: boolean;
}

export function parseFlags(argv: string[]): Flags {
  const help = argv.includes("--help") || argv.includes("-h");
  const execute = argv.includes("--execute");
  const dryRun = argv.includes("--dry-run");
  if (execute && dryRun) {
    throw new Error("Cannot pass both --execute and --dry-run");
  }

  const readInt = (name: string): number | null => {
    const arg = argv.find((value) => value.startsWith(`--${name}=`));
    if (!arg) return null;
    const parsed = Number(arg.slice(name.length + 3));
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`--${name} must be a positive integer`);
    }
    return parsed;
  };

  const orderNumberArg = argv.find((value) => value.startsWith("--order-number="));
  const orderNumber = orderNumberArg ? orderNumberArg.slice("--order-number=".length).trim() : null;
  if (orderNumber !== null && orderNumber.length === 0) {
    throw new Error("--order-number cannot be blank");
  }

  return {
    mode: execute ? "execute" : "dry-run",
    limit: readInt("limit"),
    orderNumber,
    wmsOrderId: readInt("wms-order-id"),
    pushShipStation: argv.includes("--push-shipstation"),
    help,
  };
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/backfill-active-wms-sla-ranks.ts --dry-run [--limit=25]",
    "  npx tsx scripts/backfill-active-wms-sla-ranks.ts --execute [--push-shipstation]",
    "  npx tsx scripts/backfill-active-wms-sla-ranks.ts --execute --order-number=#57954 --push-shipstation",
  ].join("\n");
}

function dateKey(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseJsonPayload(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function resolveBackfillChannelShipByDate(row: Pick<
  ActiveWmsOrderRow,
  "channel_provider" | "channel_ship_by_date" | "oms_channel_ship_by_date" | "oms_raw_payload"
>): Date | null {
  const existingOmsDate = dateKey(row.oms_channel_ship_by_date);
  if (existingOmsDate) return new Date(existingOmsDate);

  if (String(row.channel_provider ?? "").toLowerCase() === "ebay") {
    const extractedShipBy = extractEbayShipByDate(parseJsonPayload(row.oms_raw_payload));
    if (extractedShipBy) return extractedShipBy;
  }

  const existingWmsDate = dateKey(row.channel_ship_by_date);
  return existingWmsDate ? new Date(existingWmsDate) : null;
}

function utcTimestamp(column: any) {
  return sql`to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

function slaStatusFor(dueAt: Date | null, now = new Date()): string | null {
  if (!dueAt) return null;
  if (dueAt.getTime() < now.getTime()) return "overdue";
  if (dueAt.getTime() - now.getTime() <= 24 * 60 * 60 * 1000) return "at_risk";
  return "on_time";
}

async function loadActiveRows(flags: Flags): Promise<ActiveWmsOrderRow[]> {
  const limitSql = flags.limit == null ? sql`` : sql`LIMIT ${flags.limit}`;
  const orderNumberSql = flags.orderNumber == null ? sql`` : sql`AND o.order_number = ${flags.orderNumber}`;
  const wmsOrderIdSql = flags.wmsOrderId == null ? sql`` : sql`AND o.id = ${flags.wmsOrderId}`;

  const result: any = await db.execute(sql`
    SELECT
      o.id,
      o.order_number,
      COALESCE(o.channel_id, oo.channel_id) AS channel_id,
      c.provider AS channel_provider,
      oo.id AS oms_order_id,
      ${utcTimestamp(sql`oo.channel_ship_by_date`)} AS oms_channel_ship_by_date,
      oo.raw_payload AS oms_raw_payload,
      o.priority,
      o.on_hold,
      ${utcTimestamp(sql`o.channel_ship_by_date`)} AS channel_ship_by_date,
      ${utcTimestamp(sql`o.sla_due_at`)} AS sla_due_at,
      o.sort_rank,
      ${utcTimestamp(sql`o.order_placed_at`)} AS order_placed_at,
      ${utcTimestamp(sql`o.created_at`)} AS created_at
    FROM wms.orders o
    LEFT JOIN oms.oms_orders oo
      ON (
           (o.source IN ('oms', 'ebay') AND o.oms_fulfillment_order_id = oo.id::text)
        OR (o.source = 'shopify' AND o.source_table_id = oo.id::text)
      )
    LEFT JOIN channels.channels c
      ON c.id = COALESCE(o.channel_id, oo.channel_id)
    WHERE o.warehouse_status IN ('ready', 'in_progress', 'partially_shipped', 'ready_to_ship')
      AND o.cancelled_at IS NULL
      AND o.completed_at IS NULL
      ${orderNumberSql}
      ${wmsOrderIdSql}
    ORDER BY o.order_placed_at ASC NULLS LAST, o.id ASC
    ${limitSql}
  `);

  return (result?.rows ?? []).map((row: any) => ({
    ...row,
    id: Number(row.id),
    channel_id: row.channel_id == null ? null : Number(row.channel_id),
    channel_provider: row.channel_provider == null ? null : String(row.channel_provider),
    oms_order_id: row.oms_order_id == null ? null : Number(row.oms_order_id),
    priority: row.priority == null ? null : Number(row.priority),
    on_hold: row.on_hold == null ? null : Number(row.on_hold),
  }));
}

async function planUpdate(row: ActiveWmsOrderRow, now = new Date()): Promise<PlannedUpdate> {
  const nextChannelShipByDate = resolveBackfillChannelShipByDate(row);
  const nextSlaDueAt = await resolveSlaDueAt({
    channelId: row.channel_id,
    channelShipByDate: nextChannelShipByDate,
    explicitSlaDueAt: null,
    orderPlacedAt: row.order_placed_at,
    createdAt: row.created_at,
  }, db);
  const nextSortRank = computeSortRank({
    priority: row.priority ?? 0,
    onHold: row.on_hold ?? 0,
    slaDueAt: nextSlaDueAt,
    orderPlacedAt: row.order_placed_at ?? row.created_at,
    now,
  });
  const nextSlaStatus = slaStatusFor(nextSlaDueAt, now);
  const changed =
    dateKey(row.channel_ship_by_date) !== dateKey(nextChannelShipByDate) ||
    dateKey(row.sla_due_at) !== dateKey(nextSlaDueAt) ||
    row.sort_rank !== nextSortRank;
  return { row, nextChannelShipByDate, nextSlaDueAt, nextSortRank, nextSlaStatus, changed };
}

async function applyUpdate(plan: PlannedUpdate): Promise<void> {
  await db.transaction(async (tx) => {
    if (plan.row.oms_order_id != null && dateKey(plan.row.oms_channel_ship_by_date) !== dateKey(plan.nextChannelShipByDate)) {
      await tx.execute(sql`
        UPDATE oms.oms_orders
        SET
          channel_ship_by_date = ${plan.nextChannelShipByDate},
          updated_at = now()
        WHERE id = ${plan.row.oms_order_id}
      `);
    }

    await tx.execute(sql`
      UPDATE wms.orders
      SET
        channel_ship_by_date = ${plan.nextChannelShipByDate},
        sla_due_at = ${plan.nextSlaDueAt},
        sla_status = ${plan.nextSlaStatus},
        sort_rank = ${plan.nextSortRank},
        updated_at = now()
      WHERE id = ${plan.row.id}
    `);
  });
}

export async function run(flags: Flags): Promise<void> {
  if (flags.help) {
    console.log(usage());
    return;
  }

  const rows = await loadActiveRows(flags);
  console.log(
    `[WMS SLA rank backfill] mode=${flags.mode} candidates=${rows.length} limit=${flags.limit ?? "all"} pushShipStation=${flags.pushShipStation}`,
  );

  const plans: PlannedUpdate[] = [];
  const now = new Date();
  for (const row of rows) {
    const plan = await planUpdate(row, now);
    if (!plan.changed) continue;
    plans.push(plan);
    console.log(
      `[WMS SLA rank backfill] ${flags.mode === "execute" ? "UPDATE" : "PLAN"} wms=${row.id} order=${row.order_number} ` +
        `shipBy=${dateKey(row.channel_ship_by_date) ?? "null"} -> ${dateKey(plan.nextChannelShipByDate) ?? "null"} ` +
        `sla=${dateKey(row.sla_due_at) ?? "null"} -> ${dateKey(plan.nextSlaDueAt) ?? "null"} ` +
        `rank=${row.sort_rank ?? "null"} -> ${plan.nextSortRank}`,
    );
  }

  let updated = 0;
  let pushed = 0;
  if (flags.mode === "execute") {
    const shipStation = flags.pushShipStation ? createShipStationService(db) : null;
    const planByOrderId = new Map(plans.map((plan) => [plan.row.id, plan]));
    for (const row of rows) {
      const plan = planByOrderId.get(row.id);
      if (plan) {
        await applyUpdate(plan);
        updated++;
      }
      if (shipStation?.isConfigured()) {
        await shipStation.updateSortRank(row.id);
        pushed++;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  console.log(JSON.stringify({
    candidates: rows.length,
    planned: plans.length,
    updated,
    pushedShipStation: pushed,
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(parseFlags(process.argv.slice(2))).catch((err) => {
    console.error("[WMS SLA rank backfill] fatal:", err);
    process.exit(1);
  });
}
