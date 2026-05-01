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
 *   tsx scripts/parity-check-push.ts --strict         # treat address_only as diverge (legacy behavior)
 *
 * Note: --since takes precedence over --since-flag. Both narrow the
 * default 14-day window; they do NOT widen it. Use --since to compare
 * only orders pushed by the new code path after a flag flip.
 *
 * Exit codes:
 *   0 — all checked orders match within tolerance (address_only is OK by default)
 *   1 — at least one real divergence found (line items, financials, order number)
 *   2 — operational error (DB unreachable, SS API error, etc.)
 *
 * With --strict flag: address_only outcomes are promoted to diverge (exit 1).
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
  strict: boolean;
} {
  let limit = 20;
  let orderId: number | null = null;
  let tolerance = 1;
  let verbose = false;
  let silent = false;
  let since: Date | null = null;
  let strict = false;

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
    } else if (arg === "--strict") {
      strict = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { limit, orderId, tolerance, verbose, silent, since, strict };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface OmsOrderRow {
  id: number;
  shipstation_order_id: number | null;
  external_order_number: string | null;
  external_order_id: string | null;
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

/**
 * SS shipment from /shipments?orderId=<id>&includeShipmentItems=true.
 *
 * NOTE: the SS API returns per-shipment line items under the field
 * `shipmentItems`, NOT `items`. Earlier versions of this script had a
 * stale `items` field which was always undefined at runtime, so the
 * multi-shipment summation silently fell back to the parent order's
 * single-line item list.
 *
 * `items` is retained as an alias-only legacy alternative for any
 * future code that mirrors the parent order shape; current logic
 * reads `shipmentItems`.
 */
interface SsShipment {
  shipmentId: number;
  orderId: number;
  orderKey: string;
  orderNumber: string;
  trackingNumber: string;
  carrierCode: string;
  serviceCode: string;
  shipDate: string;
  voidDate: string | null;
  shipmentCost: number;
  shipmentItems?: Array<{
    orderItemId?: number;
    lineItemKey?: string | null;
    sku?: string;
    name?: string;
    quantity?: number;
    unitPrice?: number;
  }>;
  /** @deprecated SS API does not return this field; use shipmentItems. */
  items?: Array<{
    lineItemKey?: string;
    sku?: string;
    name?: string;
    quantity?: number;
    unitPrice?: number;
  }>;
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
}

type OrderOutcome =
  | "ok"
  | "diverge"
  | "address_only"
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
  addressOnly: number;
  skipped: number;
  skipReasons: Record<string, number>;
  results: OrderResult[];
}

// ---------------------------------------------------------------------------
// Levenshtein distance (inline, no deps) — used for CASS city matching
// ---------------------------------------------------------------------------
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // Use single-row optimization for memory efficiency
  let prev = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    const curr = new Array<number>(n + 1);
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
      }
    }
    prev = curr;
  }
  return prev[n];
}

// ---------------------------------------------------------------------------
// USPS street suffix abbreviation table
// ---------------------------------------------------------------------------
const STREET_SUFFIX_MAP: Record<string, string> = {
  "street": "ST",
  "st": "ST",
  "drive": "DR",
  "dr": "DR",
  "court": "CT",
  "ct": "CT",
  "boulevard": "BLVD",
  "blvd": "BLVD",
  "avenue": "AVE",
  "ave": "AVE",
  "lane": "LN",
  "ln": "LN",
  "place": "PL",
  "pl": "PL",
  "road": "RD",
  "rd": "RD",
  "circle": "CIR",
  "cir": "CIR",
  "highway": "HWY",
  "hwy": "HWY",
  "terrace": "TER",
  "ter": "TER",
  "trail": "TRL",
  "trl": "TRL",
  "parkway": "PKWY",
  "pkwy": "PKWY",
  "pike": "PIKE",
  "way": "WAY",
  "square": "SQ",
  "sq": "SQ",
};

/**
 * Normalize a street address for CASS-aware comparison.
 * - Uppercase, trim whitespace, collapse multiple spaces
 * - Replace spelled-out suffixes with USPS abbreviations
 * - Strip trailing period
 */
export function normalizeStreetAddress(address: string): string {
  const s = address.toUpperCase().trim().replace(/\s+/g, " ").replace(/\.$/, "");

  // Split into words and find the street suffix candidate.
  // Strategy: scan for the last word that matches a known suffix
  // (including already-abbreviated forms). We look from right to left,
  // skipping trailing directional words (N, S, E, W, NE, etc.) and
  // empty tokens.
  const DIRECTIONALS = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW",
    "NORTH", "SOUTH", "EAST", "WEST", "NORTHEAST", "NORTHWEST",
    "SOUTHEAST", "SOUTHWEST"]);
  const words = s.split(" ");

  for (let i = words.length - 1; i >= 0; i--) {
    const word = words[i];
    // Skip directionals at the tail
    if (DIRECTIONALS.has(word)) continue;

    const key = word.toLowerCase();
    if (key in STREET_SUFFIX_MAP) {
      words[i] = STREET_SUFFIX_MAP[key];
    }
    // Stop after the first non-directional word from the right
    break;
  }

  return words.join(" ");
}

/**
 * Normalize a ZIP code for comparison: compare on leading 5 digits only.
 * Returns the 5-digit prefix, or the original trimmed uppercase string
 * if it doesn't look like a US ZIP.
 */
export function normalizeZip(zip: string): string {
  const s = zip.trim();
  // US ZIP: 5 digits, optionally followed by dash and 4 digits
  const match = s.match(/^(\d{5})/);
  return match ? match[1] : s.toUpperCase();
}

/**
 * CASS-aware city comparison.
 * Returns true if the two city names match after normalization:
 * 1. Case-insensitive exact match
 * 2. Case-insensitive after trailing whitespace
 * 3. Levenshtein distance ≤ 3 (handles USPS truncation: FREDERICKSBRG ≈ FREDERICKSBURG)
 */
export function citiesMatchCass(a: string, b: string, maxDist = 3): boolean {
  const na = a.toUpperCase().trim();
  const nb = b.toUpperCase().trim();
  if (na === nb) return true;
  if (na.replace(/\s+$/, "") === nb.replace(/\s+$/, "")) return true;
  return levenshtein(na, nb) <= maxDist;
}

/**
 * CASS-aware address comparison.
 * Returns a set of FieldDiff entries. A field is `match: true` if the
 * normalized forms agree.
 */
export function compareShipToCass(
  ssShipTo: SsOrder["shipTo"],
  echelonShipTo: { name: string; street1: string; city: string; state: string; postalCode: string; country: string },
): FieldDiff[] {
  const norm = (v: unknown) => (v ?? "").toString().trim().replace(/\s+/g, " ");

  return [
    {
      field: "shipTo.name",
      ssValue: ssShipTo?.name,
      echelonValue: echelonShipTo.name,
      match: norm(ssShipTo?.name).toUpperCase() === norm(echelonShipTo.name).toUpperCase(),
    },
    {
      field: "shipTo.street1",
      ssValue: ssShipTo?.street1,
      echelonValue: echelonShipTo.street1,
      match: normalizeStreetAddress(ssShipTo?.street1 ?? "") === normalizeStreetAddress(echelonShipTo.street1),
    },
    {
      field: "shipTo.city",
      ssValue: ssShipTo?.city,
      echelonValue: echelonShipTo.city,
      match: citiesMatchCass(ssShipTo?.city ?? "", echelonShipTo.city),
    },
    {
      field: "shipTo.state",
      ssValue: ssShipTo?.state,
      echelonValue: echelonShipTo.state,
      match: norm(ssShipTo?.state).toUpperCase() === norm(echelonShipTo.state).toUpperCase(),
    },
    {
      field: "shipTo.postalCode",
      ssValue: ssShipTo?.postalCode,
      echelonValue: echelonShipTo.postalCode,
      match: normalizeZip(ssShipTo?.postalCode ?? "") === normalizeZip(echelonShipTo.postalCode),
    },
    {
      field: "shipTo.country",
      ssValue: ssShipTo?.country,
      echelonValue: echelonShipTo.country,
      match: norm(ssShipTo?.country).toUpperCase() === norm(echelonShipTo.country).toUpperCase(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Line item aggregation helpers (exported for tests)
// ---------------------------------------------------------------------------

/** SKU → total quantity map */
type LineItemMap = Record<string, number>;

/**
 * Build a summed line-item map from an array of items.
 * Aggregates { sku → total qty } across all entries.
 */
export function buildLineItemMap(
  items: Array<{ sku: string; qty: number }>,
): LineItemMap {
  const map: LineItemMap = {};
  for (const item of items) {
    map[item.sku] = (map[item.sku] || 0) + item.qty;
  }
  return map;
}

/**
 * Compare two summed line-item maps.
 * Returns a list of FieldDiff entries describing any SKU-level mismatches,
 * plus a summary `lineItems.sumMatch` field.
 */
export function compareLineItemMaps(
  ssMap: LineItemMap,
  echelonMap: LineItemMap,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const allSkus = new Set([...Object.keys(ssMap), ...Object.keys(echelonMap)]);

  let allMatch = true;
  for (const sku of allSkus) {
    const ssQty = ssMap[sku] ?? 0;
    const ecQty = echelonMap[sku] ?? 0;
    if (ssQty !== ecQty) {
      allMatch = false;
    }
    diffs.push({
      field: `lineItems.sum[${sku}]`,
      ssValue: ssQty,
      echelonValue: ecQty,
      match: ssQty === ecQty,
    });
  }

  diffs.unshift({
    field: "lineItems.sumMatch",
    ssValue: ssMap,
    echelonValue: echelonMap,
    match: allMatch,
  });

  return diffs;
}

// ---------------------------------------------------------------------------
// Pure comparison helpers (backward compat — used for single-shipment path)
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

/**
 * Legacy shipTo comparison (exact string match, whitespace-normalized).
 * Kept for backward compat; new code uses compareShipToCass.
 */
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
// Diff classification: determine if divergences are address-only or real
// ---------------------------------------------------------------------------

/** Fields considered "address" — divergences on these alone are address_only */
const ADDRESS_FIELDS = new Set([
  "shipTo.name",
  "shipTo.street1",
  "shipTo.city",
  "shipTo.state",
  "shipTo.postalCode",
  "shipTo.country",
]);

/**
 * Classify diffs into the appropriate outcome.
 * - All match → "ok"
 * - Only address fields mismatch → "address_only"
 * - Any non-address field mismatches → "diverge"
 */
export function classifyDiffs(diffs: FieldDiff[]): OrderOutcome {
  const mismatched = diffs.filter((d) => !d.match);
  if (mismatched.length === 0) return "ok";

  const nonAddressMismatches = mismatched.filter((d) => !ADDRESS_FIELDS.has(d.field));
  if (nonAddressMismatches.length > 0) return "diverge";

  return "address_only";
}

// ---------------------------------------------------------------------------
// Check a single order — multi-shipment aware
// ---------------------------------------------------------------------------
export async function checkSingleOrder(
  omsOrder: OmsOrderRow,
  opts: {
    tolerance: number;
    verbose: boolean;
    db: any;
    sql: any;
    getOrderById: (id: number) => Promise<any>;
    getShipments?: (
      orderId: number,
      opts?: { orderNumber?: string },
    ) => Promise<SsShipment[]>;
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

  // 1. Skip if no SS order ID
  if (!ssOrderId) {
    result.outcome = "skipped";
    result.diffs.push({ field: "_skip", ssValue: null, echelonValue: "no shipstation_order_id", match: false });
    return result;
  }

  // 2. Fetch the parent SS order (for financials, order number, custom fields)
  let ssOrder: SsOrder | null = null;
  try {
    ssOrder = await getOrderById(ssOrderId);
  } catch (err: any) {
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

  // 3. Fetch ALL SS shipments for this order (multi-shipment support)
  let ssShipments: SsShipment[] = [];
  if (opts.getShipments) {
    try {
      ssShipments = await opts.getShipments(ssOrderId, {
          orderNumber: ssOrder.orderNumber,
        });
      if (opts.verbose) {
        console.log(`    [debug] getShipments(${ssOrderId}) returned ${ssShipments.length} shipments`);
        for (const s of ssShipments) {
          const itemsArr = (s as any).shipmentItems ?? (s as any).items;
          const itemCount = Array.isArray(itemsArr) ? itemsArr.length : "undefined";
          const skuList = Array.isArray(itemsArr)
            ? itemsArr.map((it: any) => `${it?.sku ?? "?"}×${it?.quantity ?? "?"}`).join(", ")
            : "<no items array>";
          console.log(
              `      shipment ${s.shipmentId} (tracking ${s.trackingNumber || "-"}): items=${itemCount} → [${skuList}]`,
          );
        }
      }
    } catch (err: any) {
      if (opts.verbose) {
        console.log(`    [debug] getShipments(${ssOrderId}) THREW: ${err?.message ?? String(err)}`);
      }
      // If getShipments fails (e.g., not implemented), fall back to
      // single-shipment mode using the order-level items.
      ssShipments = [];
    }
  } else if (opts.verbose) {
    console.log(`    [debug] getShipments not provided — multi-shipment disabled`);
  }

  // 4. Fetch ALL WMS shipments for this OMS order (not just LIMIT 1)
  const wmsShipmentsResult: any = await db.execute(sql`
    SELECT os.id, os.order_id
    FROM wms.outbound_shipments os
    JOIN wms.orders o ON o.id = os.order_id
    WHERE o.oms_fulfillment_order_id = ${String(omsOrder.id)}
    ORDER BY os.id ASC
  `);
  const wmsShipments: Array<{ id: number; order_id: number }> = wmsShipmentsResult?.rows ?? [];

  if (wmsShipments.length === 0) {
    result.outcome = "no_wms_shipment";
    return result;
  }

  // 5. Fetch WMS order (same for all shipments of same order, use first)
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
    WHERE id = ${wmsShipments[0].order_id}
    LIMIT 1
  `);
  const wmsOrder: WmsOrderRow | undefined = orderResult?.rows?.[0];
  if (!wmsOrder) {
    result.outcome = "no_wms_shipment";
    return result;
  }

  // 6. Fetch ALL WMS shipment items across ALL shipments and aggregate
  const allWmsItems: WmsShipmentItemRow[] = [];
  for (const shipment of wmsShipments) {
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
      WHERE osi.shipment_id = ${shipment.id}
      ORDER BY osi.id ASC
    `);
    const rows: WmsShipmentItemRow[] = itemsResult?.rows ?? [];
    allWmsItems.push(...rows);
  }

  if (allWmsItems.length === 0) {
    result.outcome = "no_wms_shipment";
    return result;
  }

  // 7. Build Echelon-equivalent payload
  const EBAY_CHANNEL_ID = 67;
  const isEbay = wmsOrder.channel_id === EBAY_CHANNEL_ID;
  const baseOrderNumber = wmsOrder.order_number || wmsOrder.external_order_id || "";
  const echelonOrderNumber = isEbay ? `EB-${baseOrderNumber}` : baseOrderNumber;

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

  // 8. Compare
  const allDiffs: FieldDiff[] = [];

  // Order number
  allDiffs.push(compareOrderNumber(ssOrder.orderNumber, echelonOrderNumber));

  // Financials (from parent order — same across all split shipments)
  allDiffs.push(
    ...compareFinancials(ssOrder, echelonFinancials, tolerance, allWmsItems.length),
  );

  // Line items: aggregate across all SS shipments and all WMS shipments.
  // SS returns per-shipment line items in `shipmentItems` (only when
  // ?includeShipmentItems=true is passed on the GET /shipments call).
  // We tolerate the legacy `items` alias to stay forward/back compatible
  // with any caller that mirrors the parent-order shape.
  if (ssShipments.length > 0) {
    const ssItems: Array<{ sku: string; qty: number }> = [];
    for (const shipment of ssShipments) {
      const itemsArr = shipment.shipmentItems ?? shipment.items;
      if (itemsArr && Array.isArray(itemsArr)) {
        for (const item of itemsArr) {
          ssItems.push({ sku: item.sku || "", qty: item.quantity || 0 });
        }
      }
    }

    // If no shipment had items, fall back to order-level items
    if (ssItems.length === 0 && ssOrder.items) {
      for (const item of ssOrder.items) {
        ssItems.push({ sku: item.sku || "", qty: item.quantity || 0 });
      }
    }

    const ecItems: Array<{ sku: string; qty: number }> = allWmsItems.map(
      (item) => ({ sku: item.sku || "", qty: item.qty }),
    );

    const ssMap = buildLineItemMap(ssItems);
    const ecMap = buildLineItemMap(ecItems);
    allDiffs.push(...compareLineItemMaps(ssMap, ecMap));
  } else {
    // No shipments API available — fall back to single-shipment comparison
    // using order-level items from getOrderById.
    const echelonItemsForSingle = allWmsItems.map((item) => ({
      sku: item.sku || "",
      qty: item.qty,
      unitPrice: item.unit_price_cents / 100,
    }));
    allDiffs.push(...compareLineItems(ssOrder.items, echelonItemsForSingle, tolerance));
  }

  // Address comparison: CASS-aware
  // Use the first SS shipment's shipTo if available, otherwise fall back to
  // the parent order's shipTo (getOrderById returns it on the order object).
  const ssShipTo = ssShipments[0]?.shipTo ?? ssOrder.shipTo;
  allDiffs.push(...compareShipToCass(ssShipTo, echelonShipTo));

  // Custom field 1 (sort rank)
  allDiffs.push(compareCustomField1(ssOrder.advancedOptions?.customField1, echelonSortRank));

  // 9. Classify outcome
  result.diffs = allDiffs;
  result.outcome = classifyDiffs(allDiffs);

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

  if (result.outcome === "address_only" && !verbose) {
    const addrDiffs = result.diffs.filter((d) => !d.match);
    console.log(`  🏠 OMS #${result.omsOrderId} (SS #${result.ssOrderId}) — ADDRESS_ONLY (${addrDiffs.length} fields)`);
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

export function printSummary(report: ParityReport, strict: boolean): void {
  console.log("\n── Parity Check Summary ──────────────────────────────────");
  console.log(`  Orders checked: ${report.totalChecked}`);
  console.log(`  ✅ OK:            ${report.ok}`);
  console.log(`  🏠 Address only:  ${report.addressOnly}${strict ? " (treated as diverge in --strict mode)" : ""}`);
  console.log(`  ❌ Diverge:       ${report.diverge}`);
  console.log(`  ⏭️  Skipped:       ${report.skipped}`);
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
    getShipments?: (
      orderId: number,
      opts?: { orderNumber?: string },
    ) => Promise<SsShipment[]>;
  },
): Promise<ParityReport> {
  let db: any;
  let sqlFn: any;
  let getOrderById: (id: number) => Promise<any>;
  let getShipmentsFn:
    | ((
        orderId: number,
        opts?: { orderNumber?: string },
      ) => Promise<SsShipment[]>)
    | undefined;

  if (deps) {
    db = deps.db;
    sqlFn = deps.sql;
    getOrderById = deps.getOrderById!;
    getShipmentsFn = deps.getShipments;
  } else {
    // Dynamic imports for runtime
    const dbMod = await import("../server/db");
    db = dbMod.db;
    const drizzleMod = await import("drizzle-orm");
    sqlFn = drizzleMod.sql;
    const ssMod = await import("../server/modules/oms/shipstation.service");
    const ssService = ssMod.createShipStationService(db);
    getOrderById = (id: number) => ssService.getOrderById(id);
    // getShipments is available on the service; cast to our local type
    // (the service's ShipStationShipment doesn't declare items, but the API returns them)
    getShipmentsFn = (id: number, optsArg?: { orderNumber?: string }) =>
      ssService.getShipments(id, optsArg) as unknown as Promise<SsShipment[]>;
  }

  const report: ParityReport = {
    totalChecked: 0,
    ok: 0,
    diverge: 0,
    addressOnly: 0,
    skipped: 0,
    skipReasons: {},
    results: [],
  };

  // Query orders
  let query;
  if (args.orderId) {
    // Post-refactor: pull SS ID from wms.outbound_shipments rather than
    // the legacy oms.oms_orders.shipstation_order_id column, which is
    // NULL on all post-cutover orders. Picks the latest shipment per
    // OMS order so we always parity-check against the most recent push.
    query = sqlFn`
      SELECT DISTINCT ON (oo.id)
             oo.id,
             os.shipstation_order_id,
             oo.external_order_number,
             oo.external_order_id
      FROM oms.oms_orders oo
      JOIN wms.orders wo ON wo.oms_fulfillment_order_id = oo.id::text
      JOIN wms.outbound_shipments os ON os.order_id = wo.id
      WHERE oo.id = ${args.orderId}
        AND os.shipstation_order_id IS NOT NULL
        AND oo.cancelled_at IS NULL
      ORDER BY oo.id, os.id DESC
      LIMIT 1
    `;
  } else {
    // Post-refactor (Commit 12): the SS pointer lives on
    // wms.outbound_shipments.shipstation_order_id, not on
    // oms.oms_orders.shipstation_order_id (which is now legacy and
    // stays NULL on new orders). We must JOIN through WMS to find the
    // SS ID for any order pushed by the new pushShipment() path.
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
        getShipments: getShipmentsFn,
      });

      report.results.push(result);
      report.totalChecked++;

      if (result.outcome === "ok") {
        report.ok++;
      } else if (result.outcome === "diverge") {
        report.diverge++;
      } else if (result.outcome === "address_only") {
        report.addressOnly++;
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
    printSummary(report, args.strict);
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

    // Exit code semantics:
    //   0 — all ok or address_only (address_only is acceptable by default)
    //   1 — at least one real divergence (or address_only in --strict mode)
    //   2 — operational error
    const effectiveDiverge = args.strict
      ? report.diverge + report.addressOnly
      : report.diverge;

    if (effectiveDiverge > 0) {
      process.exit(1);
    }
    process.exit(0);
  } catch (err: any) {
    console.error(`Fatal error: ${err.message}`);
    process.exit(2);
  }
}

main();
