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
      o.channel_id,
      o.priority,
      o.on_hold,
      ${utcTimestamp(sql`o.channel_ship_by_date`)} AS channel_ship_by_date,
      ${utcTimestamp(sql`o.sla_due_at`)} AS sla_due_at,
      o.sort_rank,
      ${utcTimestamp(sql`o.order_placed_at`)} AS order_placed_at,
      ${utcTimestamp(sql`o.created_at`)} AS created_at
    FROM wms.orders o
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
    priority: row.priority == null ? null : Number(row.priority),
    on_hold: row.on_hold == null ? null : Number(row.on_hold),
  }));
}

async function planUpdate(row: ActiveWmsOrderRow, now = new Date()): Promise<PlannedUpdate> {
  const nextSlaDueAt = await resolveSlaDueAt({
    channelId: row.channel_id,
    channelShipByDate: row.channel_ship_by_date,
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
  const changed = dateKey(row.sla_due_at) !== dateKey(nextSlaDueAt) || row.sort_rank !== nextSortRank;
  return { row, nextSlaDueAt, nextSortRank, nextSlaStatus, changed };
}

async function applyUpdate(plan: PlannedUpdate): Promise<void> {
  await db.execute(sql`
    UPDATE wms.orders
    SET
      sla_due_at = ${plan.nextSlaDueAt},
      sla_status = ${plan.nextSlaStatus},
      sort_rank = ${plan.nextSortRank},
      updated_at = now()
    WHERE id = ${plan.row.id}
  `);
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
        `sla=${dateKey(row.sla_due_at) ?? "null"} -> ${dateKey(plan.nextSlaDueAt) ?? "null"} ` +
        `rank=${row.sort_rank ?? "null"} -> ${plan.nextSortRank}`,
    );
  }

  let updated = 0;
  let pushed = 0;
  if (flags.mode === "execute") {
    const shipStation = flags.pushShipStation ? createShipStationService(db) : null;
    for (const plan of plans) {
      await applyUpdate(plan);
      updated++;
      if (shipStation?.isConfigured()) {
        await shipStation.updateSortRank(plan.row.id);
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
