/**
 * Phase 1 (fulfillment-state redesign) — READ-ONLY reconciliation dry-run.
 *
 * FULFILLMENT_STATE_DESIGN.md §2.1, §7. Sizes the gap between how order
 * status is derived TODAY (from the multiset of shipment-row statuses —
 * `deriveWmsFromShipments`) and how it WILL be derived under the line
 * ledger (from per-line shipped quantities). Produces the report the
 * operator reviews BEFORE any backfill write executes.
 *
 * It writes NOTHING. There is no `--execute` flag and no INSERT/UPDATE in
 * this file. It only SELECTs and emits a report file + console summary.
 *
 * The "backfill ledger" is reconstructed in-query the same way the real
 * Phase-1 backfill will: net_shipped_qty(line) = Σ outbound_shipment_items.qty
 * over shipments whose status is shipped/returned/lost (isShipmentShipped).
 *
 * Three-way comparison per order:
 *   - stored        = wms.orders.warehouse_status (what is persisted now)
 *   - current_model = deriveWmsFromShipments(shipment statuses)  [today's fn]
 *   - new_model     = derived from per-line shipped-vs-ordered quantities
 *
 * Two axes drive the verdict (not status-shape alone):
 *   1. Does the order have ANY shipment rows? (n_ship>0). Legacy orders
 *      predating the shipment model have none; their ledger is empty, so the
 *      naive new_model is 'ready'. If such an order is stored 'shipped', a
 *      naive cutover would DOWNGRADE it — a regression. The report flags
 *      these as "cutover-guard-required", NOT as a redesign win.
 *   2. Does the new model change the answer vs the current model?
 *      (new_model != current_model). THAT is the redesign's actual effect.
 *
 * Usage:
 *   npx tsx scripts/reconcile-line-fulfillments-dryrun.ts [--since=YYYY-MM-DD] [--limit=N] [--sample=N]
 *     --since   only orders with created_at >= this date (default: all)
 *     --limit   cap number of orders scanned (default: all) — for a smoke run
 *     --sample  rows printed per flagged bucket to console (default: 25)
 *
 * Run against prod (this machine): DATABASE_URL in .env is used by
 * server/db. Importing `db` does NOT run migrations (runStartupMigrations is
 * only called from the server bootstrap), so this stays read-only.
 */

// Load .env BEFORE importing ../server/db — server/db reads
// DATABASE_URL at module-load time. On Heroku the env is already
// injected; locally it comes from .env. This import must stay first.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  deriveNewModel,
  deriveCurrentModel,
  classify,
  FLAGGED,
  type NewModel,
  type Bucket,
} from "./lib/line-fulfillment-reconcile-classify";

// ─── Args ────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { since?: string; limit?: number; sample: number } {
  let since: string | undefined;
  let limit: number | undefined;
  let sample = 25;
  for (const a of argv) {
    const m = /^--(since|limit|sample)=(.+)$/.exec(a);
    if (!m) continue;
    if (m[1] === "since") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(m[2])) throw new Error(`--since must be YYYY-MM-DD, got: ${m[2]}`);
      since = m[2];
    } else if (m[1] === "limit") {
      limit = Number(m[2]);
      if (!Number.isInteger(limit) || limit <= 0) throw new Error(`--limit must be a positive integer`);
    } else if (m[1] === "sample") {
      sample = Number(m[2]);
      if (!Number.isInteger(sample) || sample < 0) throw new Error(`--sample must be a non-negative integer`);
    }
  }
  return { since, limit, sample };
}

// ─── Types ───────────────────────────────────────────────────────────

interface OrderRow {
  order_id: number;
  order_number: string;
  source: string;
  warehouse_status: string;
  on_hold: number;
  oms_cancelled: boolean;
  n_shippable: number;
  n_fully: number;
  n_any: number;
  n_overship: number;
  total_ordered: number;
  total_shipped_capped: number;
  total_shipped_raw: number;
  total_fulfilled_counter: number;
  n_ship: number;
  n_shipped: number;
  n_onhold: number;
  n_cancelled: number;
  n_open_other: number;
}

// Pure classification (deriveNewModel / deriveCurrentModel / classify / FLAGGED)
// lives in ./lib/line-fulfillment-reconcile-classify.ts so it can be unit-tested
// without a DB. OrderRow is a structural superset of that module's ReconcileInput.

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { since, limit, sample } = parseArgs(process.argv.slice(2));
  const startedAt = new Date();

  console.log("=== Phase 1 reconciliation dry-run (READ-ONLY, no writes) ===");
  console.log(`Scope: ${since ? `orders created_at >= ${since}` : "ALL orders"}${limit ? `, limit ${limit}` : ""}`);
  console.log("");

  const sinceCond = since ? sql`WHERE o.created_at >= ${since}` : sql``;
  const limitCond = limit ? sql`LIMIT ${limit}` : sql``;

  const result = await db.execute<OrderRow>(sql`
    WITH line_ship AS (
      SELECT
        oi.order_id,
        oi.id AS order_item_id,
        oi.quantity AS ordered_qty,
        oi.requires_shipping,
        oi.status AS line_status,
        oi.fulfilled_quantity,
        COALESCE(SUM(osi.qty) FILTER (WHERE os.status IN ('shipped','returned','lost')), 0)::int AS shipped_qty
      FROM wms.order_items oi
      LEFT JOIN wms.outbound_shipment_items osi ON osi.order_item_id = oi.id
      LEFT JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
      GROUP BY oi.order_id, oi.id, oi.quantity, oi.requires_shipping, oi.status, oi.fulfilled_quantity
    ),
    order_roll AS (
      SELECT
        ls.order_id,
        COUNT(*) FILTER (WHERE ls.requires_shipping <> 0 AND ls.line_status <> 'cancelled' AND ls.ordered_qty > 0)::int AS n_shippable,
        COUNT(*) FILTER (WHERE ls.requires_shipping <> 0 AND ls.line_status <> 'cancelled' AND ls.ordered_qty > 0 AND ls.shipped_qty >= ls.ordered_qty)::int AS n_fully,
        COUNT(*) FILTER (WHERE ls.requires_shipping <> 0 AND ls.line_status <> 'cancelled' AND ls.ordered_qty > 0 AND ls.shipped_qty > 0)::int AS n_any,
        COUNT(*) FILTER (WHERE ls.requires_shipping <> 0 AND ls.line_status <> 'cancelled' AND ls.ordered_qty > 0 AND ls.shipped_qty > ls.ordered_qty)::int AS n_overship,
        COALESCE(SUM(ls.ordered_qty) FILTER (WHERE ls.requires_shipping <> 0 AND ls.line_status <> 'cancelled'), 0)::int AS total_ordered,
        COALESCE(SUM(LEAST(ls.shipped_qty, ls.ordered_qty)) FILTER (WHERE ls.requires_shipping <> 0 AND ls.line_status <> 'cancelled'), 0)::int AS total_shipped_capped,
        COALESCE(SUM(ls.shipped_qty), 0)::int AS total_shipped_raw,
        COALESCE(SUM(ls.fulfilled_quantity), 0)::int AS total_fulfilled_counter
      FROM line_ship ls
      GROUP BY ls.order_id
    ),
    ship_agg AS (
      SELECT
        os.order_id,
        COUNT(*)::int AS n_ship,
        COUNT(*) FILTER (WHERE os.status IN ('shipped','returned','lost'))::int AS n_shipped,
        COUNT(*) FILTER (WHERE os.status = 'on_hold')::int AS n_onhold,
        COUNT(*) FILTER (WHERE os.status = 'cancelled')::int AS n_cancelled,
        COUNT(*) FILTER (WHERE os.status IN ('planned','queued','labeled','voided'))::int AS n_open_other
      FROM wms.outbound_shipments os
      GROUP BY os.order_id
    )
    SELECT
      o.id AS order_id,
      o.order_number,
      o.source,
      o.warehouse_status,
      o.on_hold,
      (o.cancelled_at IS NOT NULL) AS oms_cancelled,
      r.n_shippable, r.n_fully, r.n_any, r.n_overship,
      r.total_ordered, r.total_shipped_capped, r.total_shipped_raw, r.total_fulfilled_counter,
      COALESCE(sa.n_ship, 0)::int AS n_ship,
      COALESCE(sa.n_shipped, 0)::int AS n_shipped,
      COALESCE(sa.n_onhold, 0)::int AS n_onhold,
      COALESCE(sa.n_cancelled, 0)::int AS n_cancelled,
      COALESCE(sa.n_open_other, 0)::int AS n_open_other
    FROM wms.orders o
    JOIN order_roll r ON r.order_id = o.id
    LEFT JOIN ship_agg sa ON sa.order_id = o.id
    ${sinceCond}
    ORDER BY o.id
    ${limitCond}
  `);

  const rows: OrderRow[] = (result.rows ?? []).map((r: any) => ({
    order_id: Number(r.order_id),
    order_number: String(r.order_number),
    source: String(r.source),
    warehouse_status: String(r.warehouse_status),
    on_hold: Number(r.on_hold),
    oms_cancelled: Boolean(r.oms_cancelled),
    n_shippable: Number(r.n_shippable),
    n_fully: Number(r.n_fully),
    n_any: Number(r.n_any),
    n_overship: Number(r.n_overship),
    total_ordered: Number(r.total_ordered),
    total_shipped_capped: Number(r.total_shipped_capped),
    total_shipped_raw: Number(r.total_shipped_raw),
    total_fulfilled_counter: Number(r.total_fulfilled_counter),
    n_ship: Number(r.n_ship),
    n_shipped: Number(r.n_shipped),
    n_onhold: Number(r.n_onhold),
    n_cancelled: Number(r.n_cancelled),
    n_open_other: Number(r.n_open_other),
  }));

  interface Finding extends OrderRow {
    new_model: NewModel;
    current_model: string;
    bucket: Bucket;
  }
  const findings: Finding[] = rows.map((r) => {
    const new_model = deriveNewModel(r);
    return { ...r, new_model, current_model: deriveCurrentModel(r), bucket: classify(r, new_model) };
  });

  // Tallies.
  const byBucket = new Map<Bucket, Finding[]>();
  for (const f of findings) {
    const list = byBucket.get(f.bucket) ?? [];
    list.push(f);
    byBucket.set(f.bucket, list);
  }
  const flaggedCount = findings.filter((f) => FLAGGED.has(f.bucket)).length;
  const legacyPreserve = byBucket.get("legacy_preserve") ?? [];
  const overshipped = findings.filter((f) => f.n_overship > 0);

  // Redesign effect: orders where the new model changes the derived answer vs
  // the current function. This is the redesign's true footprint.
  const redesignChanges = findings.filter((f) => f.new_model !== f.current_model);
  const transitions = new Map<string, number>();
  for (const f of redesignChanges) {
    const key = `${f.current_model} -> ${f.new_model}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
  }
  // Stored drift vs today's function (a missed recompute — fixable without the redesign).
  const missedRecompute = findings.filter((f) => f.warehouse_status !== f.current_model);

  // ── Console summary ──
  const displayOrder: Bucket[] = [
    "stale_partial", "over_reported", "missed_fulfillment",
    "cancelled_but_shipped", "hold_but_shipped", "other_mismatch",
    "legacy_preserve", "legacy_unfulfilled",
    "match", "match_no_ship", "cancelled_overlay", "hold_overlay", "no_ship_lines",
  ];
  console.log(`Orders scanned: ${findings.length}`);
  console.log(`  with shipment rows: ${findings.filter((f) => f.n_ship > 0).length}`);
  console.log(`  without (legacy):   ${findings.filter((f) => f.n_ship === 0).length}`);
  console.log("");
  console.log(`FLAGGED — live orders mis-stated vs line truth: ${flaggedCount}`);
  console.log(`CUTOVER GUARD — legacy shipped/partial w/ no shipment rows (must NOT downgrade): ${legacyPreserve.length}`);
  console.log(`REDESIGN CHANGES — new_model != current_model: ${redesignChanges.length}`);
  console.log(`Over-shipped lines (shipped_qty > ordered; dup-shipment signal): ${overshipped.length}`);
  console.log(`Stored != current-model (missed recompute, fixable today): ${missedRecompute.length}`);
  console.log("");
  console.log("bucket                  |   count | flagged");
  console.log("------------------------+---------+--------");
  for (const b of displayOrder) {
    const n = byBucket.get(b)?.length ?? 0;
    if (n === 0) continue;
    console.log(`${b.padEnd(23)} | ${String(n).padStart(7)} | ${FLAGGED.has(b) ? "  YES" : "   no"}`);
  }
  console.log("");

  if (redesignChanges.length > 0) {
    console.log("Redesign status transitions (current_model -> new_model):");
    for (const [k, n] of [...transitions.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(36)} ${String(n).padStart(7)}`);
    }
    console.log("");
  }

  // Per-bucket console sample for flagged buckets + the cutover-guard set.
  const sampleBuckets: Bucket[] = [...FLAGGED, "legacy_preserve"];
  for (const b of displayOrder) {
    if (!sampleBuckets.includes(b)) continue;
    const list = byBucket.get(b) ?? [];
    if (list.length === 0) continue;
    console.log(`── ${b} (${list.length}) — first ${Math.min(sample, list.length)} ──`);
    console.log("  order#         src        stored            current_model     new_model         ship(rows/shipped)  shippable/fully/any  ord/ship");
    for (const f of list.slice(0, sample)) {
      console.log(
        `  ${f.order_number.padEnd(14)} ${f.source.padEnd(10)} ` +
        `${f.warehouse_status.padEnd(17)} ${f.current_model.padEnd(17)} ${f.new_model.padEnd(17)} ` +
        `${f.n_ship}/${f.n_shipped}`.padEnd(19) +
        ` ${f.n_shippable}/${f.n_fully}/${f.n_any}`.padEnd(20) +
        ` ${f.total_ordered}/${f.total_shipped_capped}`,
      );
    }
    console.log("");
  }

  // ── Report file ──
  const reportDir = resolve(process.cwd(), "reports");
  mkdirSync(reportDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const reportPath = resolve(reportDir, `line-fulfillment-reconcile-${stamp}.json`);

  // Full detail for every actionable (flagged) + over-shipped order. The
  // legacy_preserve set can be tens of thousands at full scale — keep the full
  // COUNT (cutoverGuardCount) but cap its detail rows so the file stays small.
  const LEGACY_DETAIL_CAP = 300;
  const detail = [
    ...findings.filter((f) => FLAGGED.has(f.bucket) || f.n_overship > 0),
    ...legacyPreserve.slice(0, LEGACY_DETAIL_CAP),
  ];
  const report = {
    generatedAt: startedAt.toISOString(),
    scope: { since: since ?? null, limit: limit ?? null },
    ordersScanned: findings.length,
    withShipments: findings.filter((f) => f.n_ship > 0).length,
    withoutShipments: findings.filter((f) => f.n_ship === 0).length,
    flaggedCount,
    cutoverGuardCount: legacyPreserve.length,
    legacyPreserveDetailCapAt: legacyPreserve.length > LEGACY_DETAIL_CAP ? LEGACY_DETAIL_CAP : null,
    redesignChangesCount: redesignChanges.length,
    overshippedCount: overshipped.length,
    missedRecomputeCount: missedRecompute.length,
    bucketCounts: Object.fromEntries(displayOrder.map((b) => [b, byBucket.get(b)?.length ?? 0])),
    redesignTransitions: Object.fromEntries(transitions),
    detail: detail.map((f) => ({
      orderNumber: f.order_number,
      orderId: f.order_id,
      source: f.source,
      stored: f.warehouse_status,
      currentModel: f.current_model,
      newModel: f.new_model,
      bucket: f.bucket,
      onHoldFlag: f.on_hold,
      omsCancelled: f.oms_cancelled,
      lines: { shippable: f.n_shippable, fully: f.n_fully, any: f.n_any, overship: f.n_overship },
      units: {
        ordered: f.total_ordered,
        shippedCapped: f.total_shipped_capped,
        shippedRaw: f.total_shipped_raw,
        fulfilledCounter: f.total_fulfilled_counter,
      },
      shipments: {
        total: f.n_ship, shipped: f.n_shipped, onHold: f.n_onhold,
        cancelled: f.n_cancelled, openOther: f.n_open_other,
      },
    })),
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

  console.log(`Full report (${detail.length} detail rows): ${reportPath}`);
  console.log(`Elapsed: ${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s`);
  console.log("");
  console.log("READ-ONLY: no rows were written. Review the report before running the Phase 1 backfill.");

  process.exit(0);
}

main().catch((err) => {
  console.error("reconcile-line-fulfillments-dryrun.ts: fatal error");
  console.error(err);
  process.exit(2);
});
