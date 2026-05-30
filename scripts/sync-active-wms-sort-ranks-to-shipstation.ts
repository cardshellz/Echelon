/**
 * Reconcile active WMS sort_rank values into ShipStation customField1.
 *
 * This is intentionally independent from the SLA backfill: ShipStation can be
 * stale even when wms.orders.sort_rank is already correct.
 *
 * Examples:
 *   npx tsx scripts/sync-active-wms-sort-ranks-to-shipstation.ts --dry-run --limit=25
 *   npx tsx scripts/sync-active-wms-sort-ranks-to-shipstation.ts --execute --limit=25
 *   npx tsx scripts/sync-active-wms-sort-ranks-to-shipstation.ts --execute --order-number=#58258
 */

import { fileURLToPath } from "node:url";
import { db } from "../server/db";
import { sql } from "drizzle-orm";
import { createShipStationService } from "../server/modules/oms/shipstation.service";

type Mode = "dry-run" | "execute";

interface Flags {
  mode: Mode;
  limit: number | null;
  orderNumber: string | null;
  wmsOrderId: number | null;
  delayMs: number;
  help: boolean;
}

interface ActiveSortRankRow {
  id: number;
  order_number: string;
  sort_rank: string;
  active_shipments: number;
}

export function parseFlags(argv: string[]): Flags {
  const help = argv.includes("--help") || argv.includes("-h");
  const execute = argv.includes("--execute");
  const dryRun = argv.includes("--dry-run");
  if (execute && dryRun) {
    throw new Error("Cannot pass both --execute and --dry-run");
  }

  const readPositiveInt = (name: string): number | null => {
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
    limit: readPositiveInt("limit"),
    orderNumber,
    wmsOrderId: readPositiveInt("wms-order-id"),
    delayMs: readPositiveInt("delay-ms") ?? 250,
    help,
  };
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/sync-active-wms-sort-ranks-to-shipstation.ts --dry-run [--limit=25]",
    "  npx tsx scripts/sync-active-wms-sort-ranks-to-shipstation.ts --execute [--limit=25] [--delay-ms=250]",
    "  npx tsx scripts/sync-active-wms-sort-ranks-to-shipstation.ts --execute --order-number=#58258",
  ].join("\n");
}

async function loadActiveRows(flags: Flags): Promise<ActiveSortRankRow[]> {
  const limitSql = flags.limit == null ? sql`` : sql`LIMIT ${flags.limit}`;
  const orderNumberSql = flags.orderNumber == null ? sql`` : sql`AND o.order_number = ${flags.orderNumber}`;
  const wmsOrderIdSql = flags.wmsOrderId == null ? sql`` : sql`AND o.id = ${flags.wmsOrderId}`;

  const result: any = await db.execute(sql`
    SELECT
      o.id,
      o.order_number,
      o.sort_rank,
      COUNT(s.id)::int AS active_shipments
    FROM wms.orders o
    INNER JOIN wms.outbound_shipments s ON s.order_id = o.id
    WHERE o.warehouse_status IN ('ready', 'in_progress', 'partially_shipped', 'ready_to_ship')
      AND o.cancelled_at IS NULL
      AND o.completed_at IS NULL
      AND NULLIF(o.sort_rank, '') IS NOT NULL
      AND s.shipstation_order_id IS NOT NULL
      AND s.status NOT IN ('cancelled', 'voided', 'shipped', 'returned', 'lost')
      ${orderNumberSql}
      ${wmsOrderIdSql}
    GROUP BY o.id, o.order_number, o.sort_rank
    ORDER BY o.sort_rank ASC NULLS LAST, o.id ASC
    ${limitSql}
  `);

  return (result?.rows ?? []).map((row: any) => ({
    id: Number(row.id),
    order_number: String(row.order_number ?? ""),
    sort_rank: String(row.sort_rank ?? ""),
    active_shipments: Number(row.active_shipments ?? 0),
  }));
}

export async function run(flags: Flags): Promise<void> {
  if (flags.help) {
    console.log(usage());
    return;
  }

  const rows = await loadActiveRows(flags);
  console.log(
    `[ShipStation sort-rank sync] mode=${flags.mode} candidates=${rows.length} limit=${flags.limit ?? "all"} delayMs=${flags.delayMs}`,
  );

  for (const row of rows) {
    console.log(
      `[ShipStation sort-rank sync] ${flags.mode === "execute" ? "SYNC" : "PLAN"} ` +
        `wms=${row.id} order=${row.order_number} shipments=${row.active_shipments} rank=${row.sort_rank}`,
    );
  }

  let pushed = 0;
  let touched = 0;
  if (flags.mode === "execute") {
    const shipStation = createShipStationService(db);
    if (!shipStation.isConfigured()) {
      throw new Error("ShipStation is not configured");
    }

    for (const row of rows) {
      const result = await shipStation.updateSortRank(row.id);
      pushed++;
      touched += result?.touched ?? 0;
      if (flags.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, flags.delayMs));
      }
    }
  }

  console.log(JSON.stringify({
    candidates: rows.length,
    pushed,
    touchedShipStationOrders: touched,
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(parseFlags(process.argv.slice(2))).catch((err) => {
    console.error("[ShipStation sort-rank sync] fatal:", err);
    process.exit(1);
  });
}
