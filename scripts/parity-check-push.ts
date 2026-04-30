#!/usr/bin/env node
/**
 * scripts/parity-check-push.ts
 *
 * Pre-flight parity check: compares the SS payload that Shopify's
 * native SS app pushes for a given order against the SS payload
 * Echelon WOULD push for the same order. Verifies financials, line
 * items, addresses match before cutover flags are flipped.
 *
 * Plan ref: shipstation-flow-refactor-plan.md §6 Commit 37.
 *
 * Usage:
 *   tsx scripts/parity-check-push.ts                  # last 20 orders, dry
 *   tsx scripts/parity-check-push.ts --limit 50
 *   tsx scripts/parity-check-push.ts --order 12345    # one specific OMS order id
 *   tsx scripts/parity-check-push.ts --tolerance 1    # cents tolerance per line
 *   tsx scripts/parity-check-push.ts --since 2026-04-29T23:01:00Z   # restrict to orders created on/after this UTC timestamp
 *   tsx scripts/parity-check-push.ts --since-flag PUSH_FROM_WMS    # auto: filter from the most recent flip of this Heroku flag (requires HEROKU_API_TOKEN env)
 *
 * Note: --since takes precedence over --since-flag. Both narrow the
 * default 14-day window; they do NOT widen it. Use --since to compare
 * only orders pushed by the new code path after a flag flip.
 *
 * Exit codes:
 *   0 — all checked orders match within tolerance
 *   1 — at least one divergence found
 *   2 — operational error (DB unreachable, SS API error, etc.)
 *
 * Required env: same as the rest of Echelon (DATABASE_URL or
 * EXTERNAL_DATABASE_URL, SHIPSTATION_API_KEY/SECRET, etc.)
 */

// Note: no `dotenv` import — production dynos load env vars via Heroku
// runtime; local invocation can rely on the parent shell already having
// the vars set (e.g. `heroku local` or a manual `export` / `$env:` block).
// `dotenv` is a devDependency and isn't installed on the production dyno.

// ---------------------------------------------------------------------------
// CLI arg parsing (no external deps)
// ---------------------------------------------------------------------------
function parseArgs(argv: string[]): {
  limit: number;
  orderId: number | null;
  tolerance: number;
  verbose: boolean;
  silent: boolean;
  since: Date | null;
} {
  let limit = 20;
  let orderId: number | null = null;
  let tolerance = 1;
  let verbose = false;
  let silent = false;
  let since: Date | null = null;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit" && argv[i + 1]) {
      limit = parseInt(argv[++i], 10);
      if (isNaN(limit) || limit < 1) {
        throw new Error(`--limit must be a positive integer, got: ${argv[i]}`);
      }
    } else if (arg === "--order" && argv[i + 1]) {
      orderId = parseInt(argv[++i], 10);
      if (isNaN(orderId) || orderId < 1) {
        throw new Error(`--order must be a positive integer, got: ${argv[i]}`);
      }
    } else if (arg === "--tolerance" && argv[i + 1]) {
      tolerance = parseInt(argv[++i], 10);
      if (isNaN(tolerance) || tolerance < 0) {
        throw new Error(`--tolerance must be a non-negative integer, got: ${argv[i]}`);
      }
    } else if (arg === "--since" && argv[i + 1]) {
      const raw = argv[++i];
      const parsed = new Date(raw);
      if (isNaN(parsed.getTime())) {
        throw new Error(`--since must be an ISO 8601 timestamp (e.g. 2026-04-29T23:01:00Z), got: ${raw}`);
      }
      since = parsed;
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--silent") {
      silent = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { limit, orderId, tolerance, verbose, silent, since };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface OmsOrderRow {
  id: number;
  shipstation_order_id: number | null;
  external_order_number: string | null;
  external_order_id: string | null;
  // (channel name not selected — column lives on channels.name; would require JOIN. Not needed for parity logic.)
}

interface WmsOrderRow {
  id: number;
  order_number: string | null;
  channel_id: number | null;
  oms_fulfillment_order_id: string | null;
  sort_rank: string | null;
  external_order_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  shipping_name: string | null;
  shipping_address: string | null;
  shipping_city: string | null;
  shipping_state: string | null;
  shipping_postal_code: string | null;
  shipping_country: string | null;
  amount_paid_cents: number | null;
  tax_cents: number | null;
  shipping_cents: number | null;
  total_cents: number | null;
  currency: string | null;
  order_placed_at: Date | string | null;
}

interface WmsShipmentItemRow {
  id: number;
  order_item_id: number;
  sku: string | null;
  name: string | null;
  qty: number;
  unit_price_cents: number;
}

interface SsOrder {
  orderId: number;
  orderNumber: string;
  orderKey?: string;
  orderDate?: string;
  paymentDate?: string;
  orderStatus?: string;
  customerUsername?: string;
  customerEmail?: string;
  billTo?: { name?: string };
  shipTo?: {
    name?: string;
    street1?: string;
    street2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
    phone?: string;
  };
  items?: Array<{
    lineItemKey?: string;
    sku?: string;
    name?: string;
    quantity?: number;
    unitPrice?: number;
    options?: unknown[];
  }>;
  amountPaid?: number;
  taxAmount?: number;
  shippingAmount?: number;
  advancedOptions?: {
    warehouseId?: number;
    storeId?: number;
    source?: string;
    customField1?: string;
    customField2?: string;
    customField3?: string;
  };
}

type OrderOutcome =
  | "ok"
  | "diverge"
  | "no_wms_shipment"
  | "ss_not_found"
  | "skipped";

interface OrderResult {
  omsOrderId: number;
  ssOrderId: number | null;
  outcome: OrderOutcome;
  diffs: FieldDiff[];
}

interface FieldDiff {
  field: string;
  ssValue: unknown;
  echelonValue: unknown;
  match: boolean;
}

interface ParityReport {
  totalChecked: number;
  ok: number;
  diverge: number;
  skipped: number;
  skipReasons: Record<string, number>;
  results: OrderResult[];
}

// ---------------------------------------------------------------------------
// Pure comparison helpers (exported for tests)
// ---------------------------------------------------------------------------
export function compareLineItems(
  ssItems: SsOrder["items"] = [],
  echelonItems: Array<{ sku: string; qty: number; unitPrice: number }>,
  tolerance: number,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];

  diffs.push({
    field: "lineItems.count",
    ssValue: ssItems.length,
    echelonValue: echelonItems.length,
    match: ssItems.length === echelonItems.length,
  });

  if (ssItems.length !== echelonItems.length) {
    return diffs;
  }

  for (let i = 0; i < ssItems.length; i++) {
    const ss = ssItems[i];
    const ec = echelonItems[i];

    const skuMatch = (ss.sku || "") === ec.sku;
    const qtyMatch = (ss.quantity || 0) === ec.qty;
    const priceDiff = Math.abs(((ss.unitPrice || 0) - ec.unitPrice) * 100);
    const priceMatch = priceDiff <= tolerance;

    diffs.push({ field: `lineItems[${i}].sku`, ssValue: ss.sku, echelonValue: ec.sku, match: skuMatch });
    diffs.push({ field: `lineItems[${i}].quantity`, ssValue: ss.quantity, echelonValue: ec.qty, match: qtyMatch });
    diffs.push({ field: `lineItems[${i}].unitPrice`, ssValue: ss.unitPrice, echelonValue: ec.unitPrice, match: priceMatch });
  }

  return diffs;
}

export function compareFinancials(
  ssOrder: SsOrder,
  echelonFinancials: { amountPaid: number; taxAmount: number; shippingAmount: number },
  toleranceCents: number,
  lineCount: number,
): FieldDiff[] {
  const totalTolerance = toleranceCents * Math.max(lineCount, 1);
  const toDiff = (a: number, b: number) => Math.abs((a - b) * 100) <= totalTolerance;

  return [
    {
      field: "amountPaid",
      ssValue: ssOrder.amountPaid,
      echelonValue: echelonFinancials.amountPaid,
      match: toDiff(ssOrder.amountPaid ?? 0, echelonFinancials.amountPaid),
    },
    {
      field: "taxAmount",
      ssValue: ssOrder.taxAmount,
      echelonValue: echelonFinancials.taxAmount,
      match: toDiff(ssOrder.taxAmount ?? 0, echelonFinancials.taxAmount),
    },
    {
      field: "shippingAmount",
      ssValue: ssOrder.shippingAmount,
      echelonValue: echelonFinancials.shippingAmount,
      match: toDiff(ssOrder.shippingAmount ?? 0, echelonFinancials.shippingAmount),
    },
  ];
}

export function compareShipTo(
  ssShipTo: SsOrder["shipTo"],
  echelonShipTo: { name: string; street1: string; city: string; state: string; postalCode: string; country: string },
): FieldDiff[] {
  const norm = (v: unknown) => (v ?? "").toString().trim().replace(/\s+/g, " ");
  return [
    { field: "shipTo.name", ssValue: ssShipTo?.name, echelonValue: echelonShipTo.name, match: norm(ssShipTo?.name) === norm(echelonShipTo.name) },
    { field: "shipTo.street1", ssValue: ssShipTo?.street1, echelonValue: echelonShipTo.street1, match: norm(ssShipTo?.street1) === norm(echelonShipTo.street1) },
    { field: "shipTo.city", ssValue: ssShipTo?.city, echelonValue: echelonShipTo.city, match: norm(ssShipTo?.city) === norm(echelonShipTo.city) },
    { field: "shipTo.state", ssValue: ssShipTo?.state, echelonValue: echelonShipTo.state, match: norm(ssShipTo?.state) === norm(echelonShipTo.state) },
    { field: "shipTo.postalCode", ssValue: ssShipTo?.postalCode, echelonValue: echelonShipTo.postalCode, match: norm(ssShipTo?.postalCode) === norm(echelonShipTo.postalCode) },
    { field: "shipTo.country", ssValue: ssShipTo?.country, echelonValue: echelonShipTo.country, match: norm(ssShipTo?.country) === norm(echelonShipTo.country) },
  ];
}

export function compareOrderNumber(
  ssOrderNumber: string,
  echelonOrderNumber: string,
): FieldDiff {
  // Shopify-native sometimes prefixes source channel; Echelon WMS uses raw
  // order_number or EB- prefix for eBay. Normalize by stripping common prefixes
  // for comparison, but still record both values.
  const norm = (v: string) => (v || "").trim();
  return {
    field: "orderNumber",
    ssValue: ssOrderNumber,
    echelonValue: echelonOrderNumber,
    match: norm(ssOrderNumber) === norm(echelonOrderNumber),
  };
}

export function compareCustomField1(
  ssValue: string | undefined,
  echelonValue: string,
): FieldDiff {
  return {
    field: "advancedOptions.customField1",
    ssValue: ssValue ?? "",
    echelonValue,
    match: (ssValue ?? "").trim() === echelonValue.trim(),
  };
}

// ---------------------------------------------------------------------------
// Check a single order
// ---------------------------------------------------------------------------
export async function checkSingleOrder(
  omsOrder: OmsOrderRow,
  opts: {
    tolerance: number;
    verbose: boolean;
    db: any;
    sql: any;
    getOrderById: (id: number) => Promise<any>;
  },
): Promise<OrderResult> {
  const { db, sql, getOrderById, tolerance } = opts;
  const ssOrderId = omsOrder.shipstation_order_id;

  const result: OrderResult = {
    omsOrderId: omsOrder.id,
    ssOrderId,
    outcome: "ok",
    diffs: [],
  };

  // 1. Fetch Shopify-native SS order
  if (!ssOrderId) {
    result.outcome = "skipped";
    result.diffs.push({ field: "_skip", ssValue: null, echelonValue: "no shipstation_order_id", match: false });
    return result;
  }

  let ssOrder: SsOrder | null = null;
  try {
    ssOrder = await getOrderById(ssOrderId);
  } catch (err: any) {
    // 404 or other SS error
    if (err?.message?.includes("404") || err?.message?.includes("not found")) {
      result.outcome = "ss_not_found";
      return result;
    }
    throw err;
  }

  if (!ssOrder) {
    result.outcome = "ss_not_found";
    return result;
  }

  // 2. Find WMS shipment for this OMS order
  const wmsShipmentResult: any = await db.execute(sql`
    SELECT os.id, os.order_id
    FROM wms.outbound_shipments os
    JOIN wms.orders o ON o.id = os.order_id
    WHERE o.oms_fulfillment_order_id = ${String(omsOrder.id)}
    ORDER BY os.id ASC
    LIMIT 1
  `);
  const wmsShipment = wmsShipmentResult?.rows?.[0];

  if (!wmsShipment) {
    result.outcome = "no_wms_shipment";
    return result;
  }

  // 3. Build Echelon-equivalent payload (read-only, no push)
  const orderResult: any = await db.execute(sql`
    SELECT
      id, order_number, channel_id, oms_fulfillment_order_id,
      sort_rank, external_order_id,
      customer_name, customer_email,
      shipping_name, shipping_address, shipping_city, shipping_state,
      shipping_postal_code, shipping_country,
      amount_paid_cents, tax_cents, shipping_cents, total_cents, currency,
      order_placed_at
    FROM wms.orders
    WHERE id = ${wmsShipment.order_id}
    LIMIT 1
  `);
  const wmsOrder: WmsOrderRow | undefined = orderResult?.rows?.[0];
  if (!wmsOrder) {
    result.outcome = "no_wms_shipment";
    return result;
  }

  const itemsResult: any = await db.execute(sql`
    SELECT
      osi.id                    AS id,
      osi.order_item_id         AS order_item_id,
      oi.sku                    AS sku,
      oi.name                   AS name,
      osi.qty                   AS qty,
      oi.unit_price_cents       AS unit_price_cents
    FROM wms.outbound_shipment_items osi
    JOIN wms.order_items oi ON oi.id = osi.order_item_id
    WHERE osi.shipment_id = ${wmsShipment.id}
    ORDER BY osi.id ASC
  `);
  const itemRows: WmsShipmentItemRow[] = itemsResult?.rows ?? [];

  if (itemRows.length === 0) {
    result.outcome = "no_wms_shipment";
    return result;
  }

  // Build the Echelon payload values
  const EBAY_CHANNEL_ID = 67;
  const isEbay = wmsOrder.channel_id === EBAY_CHANNEL_ID;
  const baseOrderNumber = wmsOrder.order_number || wmsOrder.external_order_id || "";
  const echelonOrderNumber = isEbay ? `EB-${baseOrderNumber}` : baseOrderNumber;

  const echelonItems = itemRows.map((item: WmsShipmentItemRow) => ({
    sku: item.sku || "",
    qty: item.qty,
    unitPrice: item.unit_price_cents / 100,
  }));

  const echelonFinancials = {
    amountPaid: (wmsOrder.amount_paid_cents ?? 0) / 100,
    taxAmount: (wmsOrder.tax_cents ?? 0) / 100,
    shippingAmount: (wmsOrder.shipping_cents ?? 0) / 100,
  };

  const echelonShipTo = {
    name: wmsOrder.shipping_name || wmsOrder.customer_name || "",
    street1: wmsOrder.shipping_address || "",
    city: wmsOrder.shipping_city || "",
    state: wmsOrder.shipping_state || "",
    postalCode: wmsOrder.shipping_postal_code || "",
    country: wmsOrder.shipping_country || "US",
  };

  const echelonSortRank = wmsOrder.sort_rank || "";

  // 4. Compare
  const allDiffs: FieldDiff[] = [];

  allDiffs.push(compareOrderNumber(ssOrder.orderNumber, echelonOrderNumber));

  allDiffs.push(
    ...compareFinancials(ssOrder, echelonFinancials, tolerance, itemRows.length),
  );

  const ssItems = (ssOrder.items || []).map((item) => ({
    sku: item.sku || "",
    qty: item.quantity || 0,
    unitPrice: item.unitPrice || 0,
  }));
  allDiffs.push(...compareLineItems(ssOrder.items, echelonItems, tolerance));

  allDiffs.push(...compareShipTo(ssOrder.shipTo, echelonShipTo));

  allDiffs.push(compareCustomField1(ssOrder.advancedOptions?.customField1, echelonSortRank));

  result.diffs = allDiffs;
  result.outcome = allDiffs.every((d) => d.match) ? "ok" : "diverge";

  return result;
}

// ---------------------------------------------------------------------------
// Report printing
// ---------------------------------------------------------------------------
export function printOrderResult(result: OrderResult, verbose: boolean): void {
  if (result.outcome === "ok" && !verbose) {
    console.log(`  ✅ OMS #${result.omsOrderId} (SS #${result.ssOrderId}) — OK`);
    return;
  }

  if (result.outcome === "no_wms_shipment") {
    console.log(`  ⏭️  OMS #${result.omsOrderId} (SS #${result.ssOrderId}) — skipped (no WMS shipment)`);
    return;
  }

  if (result.outcome === "ss_not_found") {
    console.log(`  ⏭️  OMS #${result.omsOrderId} (SS #${result.ssOrderId}) — skipped (SS not found)`);
    return;
  }

  const emoji = result.outcome === "diverge" ? "❌" : "✅";
  console.log(`  ${emoji} OMS #${result.omsOrderId} (SS #${result.ssOrderId}) — ${result.outcome.toUpperCase()}`);

  if (result.outcome === "diverge" || verbose) {
    for (const diff of result.diffs) {
      if (!diff.match) {
        console.log(`    ❌ ${diff.field}: SS=${JSON.stringify(diff.ssValue)} vs Echelon=${JSON.stringify(diff.echelonValue)}`);
      } else if (verbose) {
        console.log(`    ✅ ${diff.field}: ${JSON.stringify(diff.ssValue)}`);
      }
    }
  }
}

export function printSummary(report: ParityReport): void {
  console.log("\n── Parity Check Summary ──────────────────────────────────");
  console.log(`  Orders checked: ${report.totalChecked}`);
  console.log(`  ✅ OK:          ${report.ok}`);
  console.log(`  ❌ Diverge:     ${report.diverge}`);
  console.log(`  ⏭️  Skipped:     ${report.skipped}`);
  for (const [reason, count] of Object.entries(report.skipReasons)) {
    console.log(`      ${reason}: ${count}`);
  }
  console.log("──────────────────────────────────────────────────────────");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export async function runParityCheck(
  args: ReturnType<typeof parseArgs>,
  deps?: {
    db?: any;
    sql?: any;
    getOrderById?: (id: number) => Promise<any>;
  },
): Promise<ParityReport> {
  let db: any;
  let sqlFn: any;
  let getOrderById: (id: number) => Promise<any>;

  if (deps) {
    db = deps.db;
    sqlFn = deps.sql;
    getOrderById = deps.getOrderById!;
  } else {
    // Dynamic imports for runtime
    const dbMod = await import("../server/db");
    db = dbMod.db;
    const drizzleMod = await import("drizzle-orm");
    sqlFn = drizzleMod.sql;
    const ssMod = await import("../server/modules/oms/shipstation.service");
    const ssService = ssMod.createShipStationService(db);
    getOrderById = (id: number) => ssService.getOrderById(id);
  }

  const report: ParityReport = {
    totalChecked: 0,
    ok: 0,
    diverge: 0,
    skipped: 0,
    skipReasons: {},
    results: [],
  };

  // Query orders
  let query;
  if (args.orderId) {
    query = sqlFn`
      SELECT id, shipstation_order_id, external_order_number, external_order_id
      FROM oms.oms_orders
      WHERE id = ${args.orderId}
        AND shipstation_order_id IS NOT NULL
        AND cancelled_at IS NULL
      LIMIT 1
    `;
  } else {
    // Post-refactor (Commit 12): the SS pointer lives on
    // wms.outbound_shipments.shipstation_order_id, not on
    // oms.oms_orders.shipstation_order_id (which is now legacy and
    // stays NULL on new orders). We must JOIN through WMS to find the
    // SS ID for any order pushed by the new pushShipment() path.
    //
    // Inner DISTINCT ON keeps one shipment per OMS order (latest by
    // shipment id). Outer ORDER BY then sorts by created_at DESC so
    // — limit— still means "most recent N orders".
    if (args.since) {
      query = sqlFn`
        SELECT id, shipstation_order_id, external_order_number, external_order_id
        FROM (
          SELECT DISTINCT ON (oo.id)
                 oo.id,
                 oo.created_at,
                 os.shipstation_order_id,
                 oo.external_order_number,
                 oo.external_order_id
          FROM oms.oms_orders oo
          JOIN wms.orders wo ON wo.oms_fulfillment_order_id = oo.id::text
          JOIN wms.outbound_shipments os ON os.order_id = wo.id
          WHERE os.shipstation_order_id IS NOT NULL
            AND oo.created_at >= ${args.since.toISOString()}
            AND oo.cancelled_at IS NULL
          ORDER BY oo.id, os.id DESC
        ) latest
        ORDER BY created_at DESC
        LIMIT ${args.limit}
      `;
    } else {
      query = sqlFn`
        SELECT id, shipstation_order_id, external_order_number, external_order_id
        FROM (
          SELECT DISTINCT ON (oo.id)
                 oo.id,
                 oo.created_at,
                 os.shipstation_order_id,
                 oo.external_order_number,
                 oo.external_order_id
          FROM oms.oms_orders oo
          JOIN wms.orders wo ON wo.oms_fulfillment_order_id = oo.id::text
          JOIN wms.outbound_shipments os ON os.order_id = wo.id
          WHERE os.shipstation_order_id IS NOT NULL
            AND oo.created_at > NOW() - INTERVAL '14 days'
            AND oo.cancelled_at IS NULL
          ORDER BY oo.id, os.id DESC
        ) latest
        ORDER BY created_at DESC
        LIMIT ${args.limit}
      `;
    }
  }

  const rows: any = await db.execute(query);
  const orders: OmsOrderRow[] = rows?.rows ?? [];

  if (orders.length === 0) {
    console.log("No orders found matching criteria.");
    return report;
  }

  console.log(`Checking ${orders.length} orders...\n`);

  for (const order of orders) {
    try {
      const result = await checkSingleOrder(order, {
        tolerance: args.tolerance,
        verbose: args.verbose,
        db,
        sql: sqlFn,
        getOrderById,
      });

      report.results.push(result);
      report.totalChecked++;

      if (result.outcome === "ok") {
        report.ok++;
      } else if (result.outcome === "diverge") {
        report.diverge++;
      } else {
        report.skipped++;
        report.skipReasons[result.outcome] = (report.skipReasons[result.outcome] || 0) + 1;
      }

      if (!args.silent) {
        printOrderResult(result, args.verbose);
      }
    } catch (err: any) {
      console.error(`  💥 OMS #${order.id} — error: ${err.message}`);
      report.totalChecked++;
      report.skipped++;
      report.skipReasons["error"] = (report.skipReasons["error"] || 0) + 1;
      report.results.push({
        omsOrderId: order.id,
        ssOrderId: order.shipstation_order_id,
        outcome: "skipped",
        diffs: [{ field: "_error", ssValue: null, echelonValue: err.message, match: false }],
      });
    }
  }

  if (!args.silent) {
    printSummary(report);
  }

  return report;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv);
    const report = await runParityCheck(args);

    if (report.diverge > 0) {
      process.exit(1);
    }
    process.exit(0);
  } catch (err: any) {
    console.error(`Fatal error: ${err.message}`);
    process.exit(2);
  }
}

main();
