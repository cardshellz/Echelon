/**
 * The SQL behind the Program finance summary (contract §2.0–§2.9, §3): one
 * read-only statement per section and one per reconciliation check, run by
 * PgDropshipFinanceRepository inside one REPEATABLE READ READ ONLY snapshot.
 *
 * Rules every statement here keeps:
 * - Constant SQL only. The builders choose between fixed fragments (an
 *   optional table present or not, a window that ends now or not); nothing
 *   from a request is ever spliced into the text. Values travel as $n.
 * - Every $n is cast to one type at every use (`$3::integer`), and no branch
 *   compares a parameter with a literal (`CASE WHEN $n = …`): Postgres deduces
 *   one type per parameter (contract C16, sql-parameter-literal-comparison).
 * - No statement reads the database clock (no now(), CURRENT_DATE or
 *   transaction_timestamp()): time arrives as a parameter (contract §1.1).
 * - Stored text that should hold a number is cast only after a regex guard
 *   (sqlInt), so bad data reads as "not known" instead of failing the page.
 * - OMS/WMS money columns are cast ::bigint where read (contract
 *   contradictions[2]: production column types are not proven).
 *
 * Each statement declares its parameters by name, in $n order; the
 * repository fills them from one bag of values, so the order is written once.
 */

import {
  FINANCE_STALE_PENDING_DEPOSIT_DAYS,
  FINANCE_TIME_ZONE,
} from "../../../../shared/dropship/program-finance";
import {
  FINANCE_TABLES,
  type FinanceRawTables,
  type FinanceSqlCheckId,
  type FinanceTableKey,
} from "../domain/program-finance-raw";

// ── parameters ──────────────────────────────────────────────────────────

/**
 * Every value a statement can take. Bounds are timestamptz text from Q0
 * ('-infinity' / 'infinity' included); `*Local` are Eastern wall-clock text;
 * `*Iso` are toISOString() text compared with stored ISO text (contract C7).
 */
export type FinanceSqlParam =
  | "startLocal"
  | "endLocal"
  | "cmpStartLocal"
  | "cmpEndLocal"
  | "now"
  | "startBound"
  | "endBound"
  | "cmpStartBound"
  | "cmpEndBound"
  | "vendorId"
  | "intakeId"
  | "startIso"
  | "endIso"
  | "omsStart"
  | "omsEnd";

export interface FinanceSqlStatement {
  readonly text: string;
  /** The value for $1, $2, … in order. */
  readonly params: readonly FinanceSqlParam[];
}

/** What a builder may vary on: which optional tables exist, and whether the period ends now. */
export interface FinanceSqlFlags {
  readonly tables: FinanceRawTables;
  readonly endsNow: boolean;
}

/** A frozen statement: its parameter names in $n order and its constant text. */
function statement(params: readonly FinanceSqlParam[], text: string): FinanceSqlStatement {
  return Object.freeze({ params: Object.freeze([...params]), text });
}

/** The parameters of every statement built on the order CTE: E(P) bounds, vendor, intake. */
export const ORDER_CTE_PARAMS: readonly FinanceSqlParam[] = Object.freeze(["startBound", "endBound", "vendorId", "intakeId"]);

/** ISO text standing for an open bound in the failedAt comparisons (contract C7). */
export const FINANCE_ISO_MINUS_INFINITY = "0000-01-01T00:00:00.000Z";
export const FINANCE_ISO_PLUS_INFINITY = "9999-12-31T23:59:59.999Z";

// ── fragments (contract §2.0) ───────────────────────────────────────────

const ZONE = `'${FINANCE_TIME_ZONE}'`;
/** Whole cents as text: at most 18 digits, so the bigint cast cannot overflow. */
const INT_TEXT = `'^-?[0-9]{1,18}$'`;
/** An integer id as text: at most 9 digits, so the integer cast cannot overflow. */
const ID_TEXT = `'^[0-9]{1,9}$'`;
/** A rate in basis points: at most 5 digits, so amount × rate stays inside bigint. */
const RATE_TEXT = `'^[0-9]{1,5}$'`;
/** failedAt exactly as toISOString() writes it (dropship-wallet.repository.ts failure metadata). */
const ISO_INSTANT_TEXT = `'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'`;
/** Package statuses that carry a real label; voided and cancelled ones cost $0 (spec §1.1 #7). */
const SHIPPED_PACKAGE_STATUSES = `'shipped', 'returned', 'lost'`;
const VOIDED_PACKAGE_STATUSES = `'voided', 'cancelled'`;
/** Both ShipStation id formats share one label key per ShipStation shipment (contract C1). */
const SHIPSTATION_LABEL_PATTERN = `'^shipstation_(shipment|combined):[1-9][0-9]*(:|$)'`;
/** USDC has 6 decimals; 10,000 atomic units are one cent (recon 14). */
const USDC_ATOMIC_UNITS_PER_CENT = 10_000;
/** Basis points in a whole (rewards rate). */
const BPS_PER_WHOLE = 10_000;

/** int(text), spec §3.0: stored text that is not whole cents reads as NULL (left out, counted by D7). */
export const sqlInt = (expression: string): string =>
  `(CASE WHEN (${expression}) ~ ${INT_TEXT} THEN (${expression})::bigint END)`;
/** Text present but not whole cents. */
export const sqlBad = (expression: string): string =>
  `((${expression}) IS NOT NULL AND NOT ((${expression}) ~ ${INT_TEXT}))`;
const sqlIntId = (expression: string): string =>
  `(CASE WHEN (${expression}) ~ ${ID_TEXT} THEN (${expression})::integer END)`;
/** Signed mills → cents, half away from zero: byte-for-byte the rule of signedMillsToCents. */
export const sqlRoundMills = (expression: string): string =>
  `(CASE WHEN (${expression}) < 0 THEN -((-(${expression}) + 50) / 100) ELSE ((${expression}) + 50) / 100 END)`;

/** The entry types that move a wallet's available balance (recon 1). */
export const AVAILABLE_TYPES_SQL = `'funding', 'order_debit', 'advance_fee', 'funding_reversal', 'funding_reinstated', 'return_credit', 'insurance_pool_credit', 'return_fee', 'refund_credit', 'manual_adjustment'`;
/** The entry types that move a wallet's points (CD 8). */
export const REWARDS_TYPES_SQL = `'rewards_earned', 'rewards_spent', 'rewards_expired', 'rewards_reversed', 'rewards_reinstated'`;

const vendorFilter = (column: string, param: string): string => `(${param}::integer IS NULL OR ${column} = ${param}::integer)`;

// ── Q0: bounds and tables ───────────────────────────────────────────────

const TABLE_FLAG_COLUMNS = FINANCE_TABLES
  .map((table) => `  to_regclass('${table.relation}') IS NOT NULL AS t_${table.key}`)
  .join(",\n");

/**
 * Q0, the first statement (contract §2.0 Q0). Postgres turns the Eastern
 * wall-clock bounds into instants (AT TIME ZONE handles daylight saving).
 * When the window ends now, the upper bound every later statement uses is
 * 'infinity', so the snapshot decides what counts (contract C6); end_at is
 * still now. Bounds come back as timestamptz text for the later statements
 * and as instants for the builder's cross-check.
 */
export const FINANCE_Q0: FinanceSqlStatement = statement(["startLocal", "endLocal", "now", "cmpStartLocal", "cmpEndLocal"], `
SELECT
  CASE WHEN $1::timestamp IS NULL THEN NULL ELSE $1::timestamp AT TIME ZONE ${ZONE} END AS start_at,
  CASE WHEN $1::timestamp IS NULL THEN '-infinity' ELSE ($1::timestamp AT TIME ZONE ${ZONE})::text END AS start_bound,
  LEAST($3::timestamptz, $2::timestamp AT TIME ZONE ${ZONE}) AS end_at,
  CASE WHEN ($2::timestamp AT TIME ZONE ${ZONE}) > $3::timestamptz THEN 'infinity'
       ELSE ($2::timestamp AT TIME ZONE ${ZONE})::text END AS end_bound,
  CASE WHEN $4::timestamp IS NULL THEN NULL ELSE $4::timestamp AT TIME ZONE ${ZONE} END AS cmp_start_at,
  CASE WHEN $4::timestamp IS NULL THEN NULL ELSE ($4::timestamp AT TIME ZONE ${ZONE})::text END AS cmp_start_bound,
  CASE WHEN $5::timestamp IS NULL THEN NULL ELSE $5::timestamp AT TIME ZONE ${ZONE} END AS cmp_end_at,
  CASE WHEN $5::timestamp IS NULL THEN NULL ELSE ($5::timestamp AT TIME ZONE ${ZONE})::text END AS cmp_end_bound,
${TABLE_FLAG_COLUMNS}`);

/** The vendor in view, for the page's scope line (vendor name fallback in the builder). */
export const FINANCE_VENDOR_LOOKUP: FinanceSqlStatement = statement(["vendorId"], `
SELECT v.id AS vendor_id, v.business_name, v.contact_name
FROM dropship.dropship_vendors v
WHERE v.id = $1::integer`);

// ── the order CTE (contract §2.0 ORDER_ECONOMICS_CTE) ───────────────────

/** E(P): the economics rows accepted in the window ($1 start, $2 end, $3 vendor, $4 intake). */
const ECON_CTE = `econ AS (                                   -- E(P), CD 2; e.created_at is the acceptance instant
  SELECT e.id AS econ_id, e.intake_id, e.oms_order_id, e.vendor_id, e.store_connection_id,
         e.created_at AS accepted_at, e.shipping_quote_snapshot_id, e.pricing_snapshot,
         e.total_debit_cents::bigint AS total_debit_cents, e.wholesale_subtotal_cents::bigint AS wholesale_subtotal_cents,
         e.shipping_cents::bigint AS shipping_cents, e.insurance_pool_cents::bigint AS insurance_pool_cents,
         e.fees_cents::bigint AS fees_cents
  FROM dropship.dropship_order_economics_snapshots e
  WHERE e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz
    AND ${vendorFilter("e.vendor_id", "$3")}
    AND ($4::integer IS NULL OR e.intake_id = $4::integer)
)`;

function quoteColumns(tables: FinanceRawTables): { join: string; columns: string } {
  if (!tables.quotes) {
    // The quote table is optional: without it every quote figure is "not known"
    // and the builder marks those lines unavailable (table_missing).
    return {
      join: "",
      columns: `NULL::bigint AS quote_base_cents, NULL::bigint AS quote_markup_cents,
         NULL::bigint AS quote_dunnage_cents, NULL::bigint AS quote_pool_cents, NULL::bigint AS quote_total_cents`,
    };
  }
  return {
    join: "LEFT JOIN dropship.dropship_shipping_quote_snapshots q ON q.id = econ.shipping_quote_snapshot_id",
    columns: `q.base_rate_cents::bigint AS quote_base_cents, q.markup_cents::bigint AS quote_markup_cents,
         q.dunnage_cents::bigint AS quote_dunnage_cents, q.insurance_pool_cents::bigint AS quote_pool_cents,
         q.total_shipping_cents::bigint AS quote_total_cents`,
  };
}

/**
 * The one order fragment every order figure, list and check uses (spec §3.0:
 * E(P), WMS(e), LINES(e), COST(e), PKG(e), labelKey, fully costed). Ends with
 * `classified`: one row per order with its first failing waiting reason.
 * Parameters ORDER_CTE_PARAMS.
 */
export function orderEconomicsCte(tables: FinanceRawTables): string {
  const quote = quoteColumns(tables);
  return `${ECON_CTE},
wms_o AS (                                   -- WMS(e): every WMS copy of the OMS order (CD 4)
  SELECT econ.econ_id, wo.id AS wms_order_id
  FROM econ JOIN wms.orders wo ON wo.source = 'oms' AND wo.oms_fulfillment_order_id = econ.oms_order_id::text
),
lines AS (                                   -- LINES(e) by economics.oms_order_id, never intake.oms_order_id (CD 11)
  SELECT econ.econ_id, ol.id AS line_id, ol.product_variant_id, ol.sku,
         ol.quantity::bigint AS packs, ol.total_price_cents::bigint AS line_total_cents
  FROM econ JOIN oms.oms_order_lines ol ON ol.order_id = econ.oms_order_id
),
cost_rows AS (                               -- COST(e) in signed mills (CD 4); legacy rows carry cents only
  SELECT w.econ_id, oic.id AS cost_row_id, oi.oms_order_line_id, oic.inventory_lot_id, oic.qty::bigint AS qty,
         COALESCE(NULLIF(oic.total_cost_mills, 0), oic.total_cost_cents::bigint * 100)::bigint AS mills
  FROM wms_o w
  JOIN wms.order_items oi ON oi.order_id = w.wms_order_id
  JOIN oms.order_item_costs oic ON oic.order_item_id = oi.id AND oic.order_id = oi.order_id
),
pkg AS (                                     -- PKG(e), replacements included (CD 5)
  SELECT w.econ_id, os.id AS package_id, os.shipment_purpose, os.carrier_cost_source,
         os.carrier_cost_cents::bigint AS carrier_cost_cents,
         (os.external_fulfillment_id LIKE 'shipstation\\_combined:%') AS is_combined_row,
         CASE WHEN os.external_fulfillment_id ~ ${SHIPSTATION_LABEL_PATTERN}
              THEN 'ss:' || split_part(os.external_fulfillment_id, ':', 2)
              ELSE 'os:' || os.id::text END AS label_key
  FROM wms_o w JOIN wms.outbound_shipments os ON os.order_id = w.wms_order_id
  WHERE os.status IN (${SHIPPED_PACKAGE_STATUSES})
),
ss_owners AS (                               -- who else is on the same ShipStation label, any channel (C2)
  SELECT 'ss:' || split_part(os2.external_fulfillment_id, ':', 2) AS label_key,
         COUNT(DISTINCT CASE WHEN wo2.source = 'oms' THEN 'oms:' || wo2.oms_fulfillment_order_id ELSE 'wms:' || wo2.id::text END) AS owner_count,
         bool_or(os2.external_fulfillment_id LIKE 'shipstation\\_combined:%') AS any_combined
  FROM wms.outbound_shipments os2 JOIN wms.orders wo2 ON wo2.id = os2.order_id
  WHERE os2.status IN (${SHIPPED_PACKAGE_STATUSES})
    AND os2.external_fulfillment_id ~ ${SHIPSTATION_LABEL_PATTERN}
    AND 'ss:' || split_part(os2.external_fulfillment_id, ':', 2) IN (SELECT label_key FROM pkg)
  GROUP BY 1
),
pkg_label AS (                               -- one row per (order, label): a label is never split (spec §1.1 #8)
  SELECT p.econ_id, p.label_key,
         bool_and(p.carrier_cost_source IS NOT NULL) AS costed,
         MAX(p.carrier_cost_cents) FILTER (WHERE p.carrier_cost_source IS NOT NULL) AS label_cents,
         bool_or(p.shipment_purpose = 'replacement') AS is_replacement,
         (bool_or(p.is_combined_row) OR COALESCE(bool_or(o.any_combined OR o.owner_count > 1), false)) AS is_shared
  FROM pkg p LEFT JOIN ss_owners o ON o.label_key = p.label_key
  GROUP BY p.econ_id, p.label_key
),
shipped AS (                                 -- packs shipped: customer_fulfillment items on PKG (CD 11)
  SELECT p.econ_id, SUM(osi.qty)::bigint AS shipped_packs
  FROM pkg p JOIN wms.outbound_shipment_items osi ON osi.shipment_id = p.package_id
  WHERE osi.shipment_item_purpose = 'customer_fulfillment'
  GROUP BY p.econ_id
),
line_cost AS (                               -- net Σ cost qty per OMS line (unpick rows are negative)
  SELECT l.econ_id, l.line_id, l.packs, COALESCE(SUM(c.qty), 0)::bigint AS costed_packs
  FROM lines l LEFT JOIN cost_rows c ON c.econ_id = l.econ_id AND c.oms_order_line_id = l.line_id
  GROUP BY l.econ_id, l.line_id, l.packs
),
facts AS (
  SELECT econ.*,
         ${quote.columns},
         COALESCE(oo.cancelled_at IS NOT NULL OR oo.status = 'cancelled', false) AS oms_cancelled,
         COALESCE(lt.ordered_packs, 0)::bigint AS ordered_packs, COALESCE(sh.shipped_packs, 0)::bigint AS shipped_packs,
         COALESCE(pl.labels, 0)::bigint AS labels, COALESCE(pl.labels_costed, 0)::bigint AS labels_costed,
         COALESCE(pl.any_shared, false) AS any_shared,
         COALESCE(pl.label_cents, 0)::bigint AS label_cents, COALESCE(pl.replacement_label_cents, 0)::bigint AS replacement_label_cents,
         COALESCE(lc.lines_cost_mismatch, 0)::bigint AS lines_cost_mismatch, COALESCE(lc.packs_without_cost, 0)::bigint AS packs_without_cost,
         COALESCE(cr.cogs_mills, 0)::bigint AS cogs_mills,
         (-COALESCE(pay.order_debit_cents, 0))::bigint AS paid_cash_cents,
         (-COALESCE(pay.rewards_spent_cents, 0))::bigint AS paid_points
  FROM econ
  ${quote.join}
  LEFT JOIN oms.oms_orders oo ON oo.id = econ.oms_order_id
  LEFT JOIN (SELECT econ_id, SUM(packs) AS ordered_packs FROM lines GROUP BY econ_id) lt USING (econ_id)
  LEFT JOIN shipped sh USING (econ_id)
  LEFT JOIN (SELECT econ_id, COUNT(*) AS labels, COUNT(*) FILTER (WHERE costed) AS labels_costed, bool_or(is_shared) AS any_shared,
                    SUM(label_cents) FILTER (WHERE costed) AS label_cents,
                    SUM(label_cents) FILTER (WHERE costed AND is_replacement) AS replacement_label_cents
             FROM pkg_label GROUP BY econ_id) pl USING (econ_id)
  LEFT JOIN (SELECT econ_id, COUNT(*) FILTER (WHERE costed_packs <> packs) AS lines_cost_mismatch,
                    SUM(GREATEST(packs - costed_packs, 0)) AS packs_without_cost
             FROM line_cost GROUP BY econ_id) lc USING (econ_id)
  LEFT JOIN (SELECT econ_id, SUM(mills) AS cogs_mills FROM cost_rows GROUP BY econ_id) cr USING (econ_id)
  LEFT JOIN LATERAL (                        -- unique (reference_type, reference_id): at most one row each
    SELECT SUM(l.amount_cents) FILTER (WHERE l.type = 'order_debit')   AS order_debit_cents,
           SUM(l.amount_cents) FILTER (WHERE l.type = 'rewards_spent') AS rewards_spent_cents
    FROM dropship.dropship_wallet_ledger l
    WHERE l.reference_type IN ('order_intake', 'order_intake_rewards') AND l.reference_id = econ.intake_id::text
  ) pay ON true
),
classified AS (                              -- spec §3.0 fully costed: the first failing reason wins (classifyWaitingReason mirrors it)
  SELECT f.*,
    CASE
      WHEN f.oms_cancelled                   THEN 'cancelled_in_oms'
      WHEN f.shipped_packs = 0               THEN 'not_shipped'
      WHEN f.shipped_packs < f.ordered_packs THEN 'partly_shipped'
      WHEN f.shipped_packs > f.ordered_packs THEN 'over_shipped'
      WHEN f.any_shared                      THEN 'shared_label'
      WHEN f.labels_costed < f.labels        THEN 'label_missing'
      WHEN f.lines_cost_mismatch > 0         THEN 'item_cost_missing'
    END AS waiting_reason,
    ${sqlRoundMills("f.cogs_mills")} AS cogs_cents_row
  FROM facts f
)`;
}

// ── Q1 / Q1c: orders (contract §2.1) ────────────────────────────────────

/**
 * Q1: the grand-total row and one row per waiting reason. Run again over the
 * comparison window as Q1c (the repository passes the comparison bounds as
 * startBound/endBound). An empty window still returns the grand-total row.
 */
export function ordersStatement(tables: FinanceRawTables): FinanceSqlStatement {
  return {
    params: ORDER_CTE_PARAMS,
    text: `
WITH ${orderEconomicsCte(tables)},
coverage AS (SELECT COUNT(DISTINCT label_key) AS labels, COUNT(DISTINCT label_key) FILTER (WHERE costed) AS labels_costed FROM pkg_label),
buyer AS (                                   -- CD 3: what buyers paid, read from the intake; retail_subtotal_cents is never read
  SELECT SUM(${sqlInt("i.normalized_payload->'totals'->>'grandTotalCents'")}) AS buyer_paid,
         COUNT(*) FILTER (WHERE NOT COALESCE((i.normalized_payload->'totals'->>'grandTotalCents') ~ ${INT_TEXT}, false)) AS buyer_unknown
  FROM econ JOIN dropship.dropship_order_intake i ON i.id = econ.intake_id
)
SELECT (GROUPING(c.waiting_reason) = 1) AS is_total,
       c.waiting_reason,
       COUNT(*) AS orders,
       COUNT(*) FILTER (WHERE c.waiting_reason IS NULL) AS fc_orders,
       SUM(c.total_debit_cents) AS billed,
       SUM(c.total_debit_cents) FILTER (WHERE c.waiting_reason IS NULL) AS billed_fc,
       SUM(c.wholesale_subtotal_cents) AS product_billed,
       SUM(c.wholesale_subtotal_cents) FILTER (WHERE c.waiting_reason IS NULL) AS product_billed_fc,
       SUM(c.shipping_cents) AS shipping_billed,
       SUM(c.shipping_cents - c.insurance_pool_cents) FILTER (WHERE c.waiting_reason IS NULL) AS shipping_net_pool_fc,
       SUM(c.quote_base_cents) AS quote_base,
       SUM(c.quote_markup_cents) AS quote_markup,
       SUM(c.quote_dunnage_cents) AS quote_dunnage,
       COUNT(*) FILTER (WHERE c.quote_base_cents IS NULL) AS orders_without_quote,
       SUM(c.insurance_pool_cents) AS pool_all,
       SUM(c.insurance_pool_cents) FILTER (WHERE c.waiting_reason IS NULL) AS pool_fc,
       SUM(c.paid_cash_cents) AS paid_cash,
       SUM(c.paid_points) AS paid_points,
       SUM(c.cogs_mills) FILTER (WHERE c.waiting_reason IS NULL) AS cogs_mills_fc,
       SUM(c.label_cents) FILTER (WHERE c.waiting_reason IS NULL) AS labels_fc,
       SUM(c.replacement_label_cents) FILTER (WHERE c.waiting_reason IS NULL) AS replacement_labels_fc,
       MAX(cov.labels) AS cov_labels,
       MAX(cov.labels_costed) AS cov_labels_costed,
       MAX(b.buyer_paid) AS buyer_paid,
       MAX(b.buyer_unknown) AS buyer_unknown
FROM classified c CROSS JOIN coverage cov CROSS JOIN buyer b
GROUP BY GROUPING SETS ((), (c.waiting_reason))`,
  };
}

// ── Q2: products by size (contract §2.2) ────────────────────────────────

function catalogJoins(tables: FinanceRawTables): { joins: string; columns: string } {
  // The catalog tables are optional: without them a line has no size, name or
  // pieces per pack, and the builder marks pieces unavailable (table_missing).
  const variantJoin = tables.variants ? "LEFT JOIN catalog.product_variants pv ON pv.id = l.product_variant_id" : "";
  const productJoin = tables.variants && tables.products ? "LEFT JOIN catalog.products p ON p.id = pv.product_id" : "";
  const variantColumns = tables.variants
    ? "pv.sku AS variant_sku, pv.name AS size_name, pv.units_per_variant::bigint AS units_per_variant, pv.product_id"
    : "NULL::text AS variant_sku, NULL::text AS size_name, NULL::bigint AS units_per_variant, NULL::integer AS product_id";
  const productColumns = tables.variants && tables.products ? "p.name AS product_name" : "NULL::text AS product_name";
  return { joins: [variantJoin, productJoin].filter(Boolean).join("\n  "), columns: `${variantColumns}, ${productColumns}` };
}

/** Q2: the total row and one row per catalog size ("v:<id>") or unlinked SKU ("sku:<sku>"). */
export function productsStatement(tables: FinanceRawTables): FinanceSqlStatement {
  const catalog = catalogJoins(tables);
  return {
    params: ORDER_CTE_PARAMS,
    text: `
WITH ${orderEconomicsCte(tables)},
line_mills AS (SELECT econ_id, oms_order_line_id, SUM(mills)::bigint AS mills FROM cost_rows GROUP BY 1, 2),
unlinked AS (                                -- C10: cost rows of fully costed orders linked to no line of the order
  SELECT SUM(c.mills)::bigint AS mills
  FROM cost_rows c JOIN classified k ON k.econ_id = c.econ_id AND k.waiting_reason IS NULL
  WHERE c.oms_order_line_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM lines l WHERE l.econ_id = c.econ_id AND l.line_id = c.oms_order_line_id)
),
line_shipped AS (
  SELECT oi.oms_order_line_id, SUM(osi.qty)::bigint AS shipped
  FROM pkg p
  JOIN wms.outbound_shipment_items osi ON osi.shipment_id = p.package_id AND osi.shipment_item_purpose = 'customer_fulfillment'
  JOIN wms.order_items oi ON oi.id = osi.order_item_id
  GROUP BY 1
),
pl AS (
  SELECT l.*, (k.waiting_reason IS NULL) AS fc, COALESCE(lm.mills, 0)::bigint AS mills, COALESCE(ls.shipped, 0)::bigint AS shipped,
         CASE WHEN l.product_variant_id IS NOT NULL THEN 'v:' || l.product_variant_id::text ELSE 'sku:' || COALESCE(l.sku, '') END AS group_key,
         ${catalog.columns}
  FROM lines l
  JOIN classified k ON k.econ_id = l.econ_id
  LEFT JOIN line_mills lm ON lm.econ_id = l.econ_id AND lm.oms_order_line_id = l.line_id
  LEFT JOIN line_shipped ls ON ls.oms_order_line_id = l.line_id
  ${catalog.joins}
)
SELECT (GROUPING(pl.group_key) = 1) AS is_total,
       pl.group_key,
       MIN(pl.product_variant_id) AS product_variant_id,
       MIN(pl.product_id) AS product_id,
       MIN(pl.product_name) AS product_name,
       MIN(pl.size_name) AS size_name,
       MIN(COALESCE(pl.variant_sku, pl.sku)) AS sku,
       MIN(pl.units_per_variant) AS units_per_variant,
       COALESCE(SUM(pl.packs), 0) AS packs,
       SUM(pl.packs * pl.units_per_variant) FILTER (WHERE pl.units_per_variant IS NOT NULL) AS pieces,
       COUNT(*) FILTER (WHERE pl.units_per_variant IS NULL) AS lines_without_pieces,
       COALESCE(SUM(pl.shipped), 0) AS packs_shipped,
       COALESCE(SUM(pl.packs) FILTER (WHERE pl.fc), 0) AS packs_fc,
       COALESCE(SUM(pl.line_total_cents), 0) AS billed_product,
       COALESCE(SUM(pl.line_total_cents) FILTER (WHERE pl.fc), 0) AS billed_product_fc,
       COALESCE(SUM(pl.mills) FILTER (WHERE pl.fc), 0) AS cogs_mills_fc,
       COALESCE(MAX(u.mills), 0) AS unlinked_cogs_mills_fc
FROM pl CROSS JOIN unlinked u
GROUP BY GROUPING SETS ((), (pl.group_key))`,
  };
}

// ── Q3: received and never charged (contract §2.3) ──────────────────────

/** Q3: intakes received in the period that ended without a charge, by kind ($1 start, $2 end, $3 vendor). */
export function neverChargedStatement(tables: FinanceRawTables): FinanceSqlStatement {
  // Without the audit table there is no "would have charged" amount; the
  // builder marks that line unavailable (table_missing).
  const held = tables.audit
    ? `LEFT JOIN LATERAL (
  SELECT ${sqlInt("a.payload->>'totalDebitCents'")} AS total_debit
  FROM dropship.dropship_audit_events a
  WHERE a.entity_type = 'dropship_order_intake' AND a.entity_id = i.id::text AND a.event_type = 'order_acceptance_payment_hold'
  ORDER BY a.created_at DESC, a.id DESC LIMIT 1
) h ON i.kind IN ('waiting_for_payment', 'payment_time_ran_out')`
    : "";
  const wouldHaveCharged = tables.audit ? "SUM(h.total_debit)" : "NULL::bigint";
  return {
    params: ["startBound", "endBound", "vendorId"],
    text: `
SELECT i.kind,
       COUNT(*) AS orders,
       SUM(${sqlInt("i.normalized_payload->'totals'->>'grandTotalCents'")}) AS buyer_total,
       COUNT(*) FILTER (WHERE NOT COALESCE((i.normalized_payload->'totals'->>'grandTotalCents') ~ ${INT_TEXT}, false)) AS buyer_unknown,
       ${wouldHaveCharged} AS would_have_charged
FROM (SELECT i.*, CASE
        WHEN i.status = 'payment_hold' THEN 'waiting_for_payment'
        WHEN i.cancellation_status = 'payment_hold_expired' THEN 'payment_time_ran_out'
        WHEN i.cancellation_status = 'order_intake_rejected' OR i.status = 'rejected' THEN 'rejected'
        WHEN i.cancellation_status = 'marketplace_cancelled' THEN 'marketplace_cancelled'
        WHEN i.status = 'failed' THEN 'failed'
        WHEN i.status = 'exception' THEN 'exception' END AS kind
      FROM dropship.dropship_order_intake i
      WHERE i.received_at >= $1::timestamptz AND i.received_at < $2::timestamptz
        AND ${vendorFilter("i.vendor_id", "$3")}) i
${held}
WHERE i.kind IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM dropship.dropship_order_economics_snapshots e WHERE e.intake_id = i.id)
GROUP BY i.kind`,
  };
}

// ── ledger rows (shared by Q4, VENDORS_SQL and the deposit checks) ──────

/**
 * Every ledger row with how it moved: deposits by settled_at, everything else
 * by created_at (spec §3.0 "moved in P"), and a deposit's line: staff credit,
 * weekly collection, its rail, or unknown. The rail comes from the entry's
 * metadata, else its funding method (contract contradictions[0]).
 */
function ledgerRowsCte(vendorParam: string): string {
  const rail = "COALESCE(l.metadata->>'rail', fm.rail)";
  return `lx AS (
  SELECT l.id, l.vendor_id, l.wallet_account_id, l.type, l.status, l.reference_type, l.reference_id,
         l.amount_cents::bigint AS amount_cents, l.created_at, l.settled_at, l.metadata,
         CASE WHEN l.type = 'funding' THEN l.settled_at ELSE l.created_at END AS moved_at,
         COALESCE(l.metadata->>'rail', fm.rail, 'unknown') AS rail,
         CASE WHEN l.type <> 'funding' THEN NULL
              WHEN ${rail} = 'manual' THEN 'manual'
              WHEN l.metadata->>'collection' = 'true' THEN 'collection'
              WHEN ${rail} IN ('stripe_ach', 'stripe_card', 'usdc_base') THEN ${rail}
              ELSE 'unknown' END AS cash_line
  FROM dropship.dropship_wallet_ledger l
  LEFT JOIN dropship.dropship_funding_methods fm ON fm.id = l.funding_method_id
  WHERE ${vendorFilter("l.vendor_id", vendorParam)}
)`;
}

// ── Q4: ledger groups (contract §2.4) ───────────────────────────────────

const charged = sqlInt("f.metadata->>'chargedCents'");
const cardFee = sqlInt("f.metadata->>'cardFeeCents'");
const dispute = sqlInt("f.metadata->>'disputeAmountCents'");
const fromCash = sqlInt("f.metadata->'rewardsClawback'->>'fromCashCents'");

/**
 * Q4: one scan of the ledger, grouped so the builder can sum any line in
 * BigInt. Parameters: $1/$2 period bounds, $3/$4 comparison bounds or NULL,
 * $5 vendor, $6/$7 the period as ISO text (failedAt is ISO text, C7), $8 now.
 */
export const FINANCE_LEDGER_GROUPS: FinanceSqlStatement = statement(["startBound", "endBound", "cmpStartBound", "cmpEndBound", "vendorId", "startIso", "endIso", "now"], `
WITH ${ledgerRowsCte("$5")},
f AS (
  SELECT lx.*,
         (lx.status = 'settled' AND lx.moved_at >= $1::timestamptz AND lx.moved_at < $2::timestamptz) AS in_p,
         ($3::timestamptz IS NOT NULL AND lx.status = 'settled'
           AND lx.moved_at >= $3::timestamptz AND lx.moved_at < $4::timestamptz) AS in_cmp,
         CASE WHEN lx.type = 'rewards_earned' THEN lx.rail END AS rewards_rail,
         (lx.metadata->>'autoReload') = 'true' AS auto_reload,
         lx.metadata->>'autoReloadReason' AS auto_reload_reason,
         (lx.metadata->>'source') = 'chain_watcher' AS chain_watcher,
         CASE WHEN (lx.metadata->'failure'->>'failedAt') ~ ${ISO_INSTANT_TEXT}
              THEN lx.metadata->'failure'->>'failedAt' END AS failed_at_txt
  FROM lx
)
SELECT f.vendor_id, f.type, f.status, f.reference_type, f.cash_line, f.rewards_rail,
       f.auto_reload, f.auto_reload_reason, f.chain_watcher,
       COUNT(*) FILTER (WHERE f.in_p) AS n_p,
       SUM(f.amount_cents) FILTER (WHERE f.in_p) AS amount_p,
       SUM(COALESCE(${charged}, f.amount_cents)) FILTER (WHERE f.in_p AND f.type = 'funding') AS charged_p,
       SUM(${cardFee}) FILTER (WHERE f.in_p AND f.type = 'funding') AS card_fee_p,
       SUM(${dispute}) FILTER (WHERE f.in_p AND f.type = 'funding_reversal') AS dispute_p,
       COUNT(*) FILTER (WHERE f.in_p AND f.type = 'funding_reversal' AND ${dispute} IS NULL) AS dispute_missing_p,
       SUM(${fromCash}) FILTER (WHERE f.in_p AND f.type = 'funding_reversal') AS from_cash_p,
       COUNT(*) FILTER (WHERE f.in_p AND (${sqlBad("f.metadata->>'chargedCents'")}
                                       OR ${sqlBad("f.metadata->>'cardFeeCents'")}
                                       OR ${sqlBad("f.metadata->>'disputeAmountCents'")}
                                       OR ${sqlBad("f.metadata->'rewardsClawback'->>'fromCashCents'")})) AS malformed_p,
       COUNT(*) FILTER (WHERE f.in_cmp) AS n_cmp,
       SUM(f.amount_cents) FILTER (WHERE f.in_cmp) AS amount_cmp,
       SUM(COALESCE(${charged}, f.amount_cents)) FILTER (WHERE f.in_cmp AND f.type = 'funding') AS charged_cmp,
       SUM(${dispute}) FILTER (WHERE f.in_cmp AND f.type = 'funding_reversal') AS dispute_cmp,
       SUM(f.amount_cents) FILTER (WHERE f.status = 'settled' AND f.settled_at < $1::timestamptz) AS amount_before_start,
       SUM(f.amount_cents) FILTER (WHERE f.status = 'settled' AND f.settled_at < $2::timestamptz) AS amount_before_end,
       COUNT(*) FILTER (WHERE f.status = 'pending') AS n_pending_now,
       SUM(f.amount_cents) FILTER (WHERE f.status = 'pending') AS amount_pending_now,
       COUNT(*) FILTER (WHERE f.status = 'pending'
                          AND f.created_at < $8::timestamptz - interval '${FINANCE_STALE_PENDING_DEPOSIT_DAYS} days') AS n_stale,
       SUM(f.amount_cents) FILTER (WHERE f.status = 'pending'
                          AND f.created_at < $8::timestamptz - interval '${FINANCE_STALE_PENDING_DEPOSIT_DAYS} days') AS amount_stale,
       SUM(f.amount_cents) FILTER (WHERE f.type = 'funding' AND f.created_at < $2::timestamptz
             AND NOT (f.settled_at IS NOT NULL AND f.settled_at < $2::timestamptz)
             AND NOT (f.status = 'failed' AND f.failed_at_txt IS NOT NULL AND f.failed_at_txt COLLATE "C" < $7::text)) AS amount_pending_at_end,
       COUNT(*) FILTER (WHERE f.status = 'failed'
                          AND f.failed_at_txt COLLATE "C" >= $6::text AND f.failed_at_txt COLLATE "C" < $7::text) AS n_failed_p,
       SUM(f.amount_cents) FILTER (WHERE f.status = 'failed'
                          AND f.failed_at_txt COLLATE "C" >= $6::text AND f.failed_at_txt COLLATE "C" < $7::text) AS amount_failed_p,
       COUNT(*) FILTER (WHERE f.status = 'failed' AND f.failed_at_txt IS NULL) AS failed_without_time
FROM f
GROUP BY f.vendor_id, f.type, f.status, f.reference_type, f.cash_line, f.rewards_rail,
         f.auto_reload, f.auto_reload_reason, f.chain_watcher`);

/**
 * The failure code of the earliest deposit that failed in the period (by
 * failedAt text, then id): the cash memo shows it as stored. $1 vendor,
 * $2/$3 the period as ISO text.
 */
export const FINANCE_FIRST_FAILURE_CODE: FinanceSqlStatement = statement(["vendorId", "startIso", "endIso"], `
SELECT l.metadata->'failure'->>'code' AS failure_code
FROM dropship.dropship_wallet_ledger l
WHERE l.type = 'funding' AND l.status = 'failed'
  AND ${vendorFilter("l.vendor_id", "$1")}
  AND (l.metadata->'failure'->>'failedAt') ~ ${ISO_INSTANT_TEXT}
  AND (l.metadata->'failure'->>'failedAt') COLLATE "C" >= $2::text
  AND (l.metadata->'failure'->>'failedAt') COLLATE "C" < $3::text
ORDER BY (l.metadata->'failure'->>'failedAt') COLLATE "C", l.id
LIMIT 1`);

// ── Q5a / Q5b: disputes (contract §2.5) ─────────────────────────────────

/** How a win finds its pull-back: the id it recorded, else the same Stripe dispute. */
const PAIRED_REVERSAL = `LEFT JOIN LATERAL (
  SELECT rv.id, rv.metadata FROM dropship.dropship_wallet_ledger rv
  WHERE rv.type = 'funding_reversal'
    AND (rv.id = ri.reversal_id
         OR (ri.reversal_id IS NULL AND rv.reference_type = 'stripe_dispute' AND rv.reference_id = ri.reference_id))
  ORDER BY rv.id LIMIT 1
) rv ON true`;

/** Q5a: settled wins in the period or the comparison window ($1/$2 period, $3/$4 comparison or NULL, $5 vendor). */
export const FINANCE_WON_DISPUTES: FinanceSqlStatement = statement(["startBound", "endBound", "cmpStartBound", "cmpEndBound", "vendorId"], `
WITH ri AS (
  SELECT ri.id, ri.vendor_id, ri.created_at, ri.amount_cents::bigint AS amount_cents, ri.reference_id,
         ${sqlIntId("ri.metadata->>'reversalLedgerEntryId'")} AS reversal_id
  FROM dropship.dropship_wallet_ledger ri
  WHERE ri.type = 'funding_reinstated' AND ri.status = 'settled'
    AND ${vendorFilter("ri.vendor_id", "$5")}
    AND ((ri.created_at >= $1::timestamptz AND ri.created_at < $2::timestamptz)
      OR ($3::timestamptz IS NOT NULL AND ri.created_at >= $3::timestamptz AND ri.created_at < $4::timestamptz))
)
SELECT (ri.created_at >= $1::timestamptz AND ri.created_at < $2::timestamptz) AS in_p,
       COALESCE($3::timestamptz IS NOT NULL AND ri.created_at >= $3::timestamptz AND ri.created_at < $4::timestamptz, false) AS in_cmp,
       ri.id AS reinstated_id,
       ri.amount_cents AS restored_cents,
       rv.id AS reversal_id,
       ${sqlInt("rv.metadata->>'disputeAmountCents'")} AS disputed_cents,
       ${sqlInt("rv.metadata->>'creditAmountCents'")} AS credit_cents,
       ${sqlInt("rv.metadata->'rewardsClawback'->>'fromCashCents'")} AS from_cash_cents
FROM ri
${PAIRED_REVERSAL}
ORDER BY ri.id`);

/** Q5b: pull-backs in the period not won back (open or lost cannot be told apart, recon 13). $1/$2 period, $3 vendor. */
export const FINANCE_NOT_WON_BACK: FinanceSqlStatement = statement(["startBound", "endBound", "vendorId"], `
SELECT COUNT(*) AS disputes,
       SUM(${sqlInt("rv.metadata->>'disputeAmountCents'")}) AS disputed_cents
FROM dropship.dropship_wallet_ledger rv
WHERE rv.type = 'funding_reversal' AND rv.status = 'settled'
  AND rv.created_at >= $1::timestamptz AND rv.created_at < $2::timestamptz
  AND ${vendorFilter("rv.vendor_id", "$3")}
  AND NOT EXISTS (SELECT 1 FROM dropship.dropship_wallet_ledger x
                  WHERE x.reference_type = 'stripe_dispute_reinstated' AND x.reference_id = rv.reference_id)`);

// ── Q6: return-fee parts (contract §2.6) ────────────────────────────────

/** Q6: the period's settled return fees by reference type, split into their parts where recorded. $1/$2 period, $3 vendor. */
export function returnFeesStatement(tables: FinanceRawTables): FinanceSqlStatement {
  const referencedId = sqlIntId("split_part(l.reference_id, ':', 1)");
  const part = (settlementColumn: string, inspectionKey: string): string => {
    const fromInspection = tables.inspections ? sqlInt(`ins.fee_breakdown->'fees'->'${inspectionKey}'->>'chargedCents'`) : "NULL::bigint";
    const fromSettlement = tables.settlements ? `s.${settlementColumn}::bigint` : "NULL::bigint";
    return `COALESCE(SUM(COALESCE(${fromSettlement}, ${fromInspection})), 0)`;
  };
  // Optional tables: the join is left out and their parts read 0; the builder
  // marks the part lines unavailable (table_missing) when either is missing.
  const settlementJoin = tables.settlements
    ? `LEFT JOIN returns.return_case_vendor_settlements s
  ON l.reference_type = 'return_case_vendor_settlement' AND s.id = ${referencedId}`
    : "";
  const inspectionJoin = tables.inspections
    ? `LEFT JOIN dropship.dropship_rma_inspections ins
  ON l.reference_type = 'dropship_rma' AND ins.rma_id = ${referencedId}`
    : "";
  const noSettlement = tables.settlements ? "s.id IS NULL" : "true";
  const noBreakdown = tables.inspections ? "(ins.id IS NULL OR ins.fee_breakdown->'fees' IS NULL)" : "true";
  return {
    params: ["startBound", "endBound", "vendorId"],
    text: `
SELECT l.reference_type,
       COUNT(*) AS fee_rows,
       SUM(-l.amount_cents::bigint) AS fee_cents,
       ${part("restocking_fee_cents", "restocking")} AS restocking,
       ${part("processing_fee_cents", "processing")} AS processing,
       ${part("return_shipping_fee_cents", "returnShipping")} AS return_label,
       COUNT(*) FILTER (WHERE ${noSettlement} AND ${noBreakdown}) AS split_not_recorded
FROM dropship.dropship_wallet_ledger l
${settlementJoin}
${inspectionJoin}
WHERE l.type = 'return_fee' AND l.status = 'settled'
  AND l.created_at >= $1::timestamptz AND l.created_at < $2::timestamptz
  AND ${vendorFilter("l.vendor_id", "$3")}
GROUP BY l.reference_type`,
  };
}

// ── Q7: wallets now (contract §2.7) ─────────────────────────────────────

/**
 * Q7: every wallet now, with its points lots by when they expire, relative
 * to the injected now. Lots already past due count in "next 30 days" until
 * the sweep expires them. $1 vendor, $2 now.
 */
export function walletsStatement(tables: FinanceRawTables): FinanceSqlStatement {
  const lotsJoin = tables.lots
    ? `LEFT JOIN (
  SELECT lot.wallet_account_id,
         SUM(lot.remaining_cents) FILTER (WHERE lot.remaining_cents > 0 AND lot.expires_at IS NOT NULL
                                            AND lot.expires_at < $2::timestamptz + interval '30 days') AS exp_30,
         SUM(lot.remaining_cents) FILTER (WHERE lot.remaining_cents > 0 AND lot.expires_at >= $2::timestamptz + interval '30 days'
                                            AND lot.expires_at < $2::timestamptz + interval '90 days') AS exp_90,
         SUM(lot.remaining_cents) FILTER (WHERE lot.remaining_cents > 0 AND lot.expires_at >= $2::timestamptz + interval '90 days') AS exp_later,
         SUM(lot.remaining_cents) FILTER (WHERE lot.remaining_cents > 0 AND lot.expires_at IS NULL) AS never
  FROM dropship.dropship_wallet_rewards_lots lot
  GROUP BY lot.wallet_account_id
) lt ON lt.wallet_account_id = a.id`
    : "";
  const bucket = (column: string) => (tables.lots ? `COALESCE(lt.${column}, 0)` : "0");
  // Without the lots table $2 has no use; it is still cast so its type is fixed.
  const nowGuard = tables.lots ? "" : "\n  AND $2::timestamptz IS NOT NULL";
  return {
    params: ["vendorId", "now"],
    text: `
SELECT a.id AS wallet_id, a.vendor_id,
       a.available_balance_cents::bigint AS available,
       a.pending_balance_cents::bigint AS pending,
       a.rewards_balance_cents::bigint AS points,
       ${bucket("exp_30")} AS exp_30,
       ${bucket("exp_90")} AS exp_90,
       ${bucket("exp_later")} AS exp_later,
       ${bucket("never")} AS never
FROM dropship.dropship_wallet_accounts a
${lotsJoin}
WHERE ${vendorFilter("a.vendor_id", "$1")}${nowGuard}
ORDER BY a.vendor_id, a.id`,
  };
}

// ── Q8: insurance pool and claims (contract §2.8) ───────────────────────

/**
 * Q8: what the pool took from orders (vendor-scoped) and its own record
 * (program-wide; 0 without the pool-ledger table, whose lines the builder
 * marks unavailable). $1/$2 period, $3 vendor.
 */
export function poolStatement(tables: FinanceRawTables): FinanceSqlStatement {
  const poolSum = (where: string) => tables.pool_ledger
    ? `(SELECT COALESCE(SUM(pl.amount_cents), 0)::bigint FROM dropship.dropship_insurance_pool_ledger pl WHERE ${where})`
    : "0::bigint";
  const topUps = "pl.entry_type IN ('claim_replenishment', 'manual_adjustment')";
  return {
    params: ["startBound", "endBound", "vendorId"],
    text: `
SELECT
  (SELECT COALESCE(SUM(e.insurance_pool_cents), 0)::bigint FROM dropship.dropship_order_economics_snapshots e
     WHERE e.created_at < $1::timestamptz AND ${vendorFilter("e.vendor_id", "$3")}) AS set_aside_before_start,
  (SELECT COALESCE(SUM(e.insurance_pool_cents), 0)::bigint FROM dropship.dropship_order_economics_snapshots e
     WHERE e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz AND ${vendorFilter("e.vendor_id", "$3")}) AS set_aside_p,
  ${poolSum(`${topUps} AND pl.created_at < $1::timestamptz`)} AS topped_up_before_start,
  ${poolSum(`${topUps} AND pl.created_at >= $1::timestamptz AND pl.created_at < $2::timestamptz`)} AS topped_up_p,
  ${poolSum("pl.created_at < $2::timestamptz")} AS recorded_ledger_at_end`,
  };
}

/** Q8 claims filed in the period by status; claims carry no vendor, so the intake scopes them. $1/$2 period, $3 vendor. */
export const FINANCE_POOL_CLAIMS: FinanceSqlStatement = statement(["startBound", "endBound", "vendorId"], `
SELECT c.status, COUNT(*) AS claims, COALESCE(SUM(c.calculated_credit_cents), 0) AS asked
FROM dropship.dropship_carrier_claims c
LEFT JOIN dropship.dropship_order_intake i ON i.id = c.intake_id
WHERE c.created_at >= $1::timestamptz AND c.created_at < $2::timestamptz
  AND ${vendorFilter("i.vendor_id", "$3")}
GROUP BY c.status
ORDER BY c.status`);

// ── Q9: Overview bridge (contract §2.9, program view only) ──────────────

/**
 * Q9: the Overview dashboard's Dropship row over the same days. OMS
 * `ordered_at` is naive Eastern wall clock, so the bounds are wall-clock text
 * too ($1 start or NULL for all time, $2 end; 'infinity' when the period
 * ends now, C6).
 */
export const FINANCE_OVERVIEW_BRIDGE: FinanceSqlStatement = statement(["omsStart", "omsEnd"], `
WITH dch AS (SELECT DISTINCT channel_id FROM dropship.dropship_order_intake WHERE channel_id IS NOT NULL),
oms_row AS (
  SELECT oo.total_cents::bigint AS total_cents, (e.id IS NOT NULL) AS accepted
  FROM oms.oms_orders oo
  LEFT JOIN dropship.dropship_order_economics_snapshots e ON e.oms_order_id = oo.id
  WHERE oo.channel_id IN (SELECT channel_id FROM dch)
    AND ($1::timestamp IS NULL OR oo.ordered_at >= $1::timestamp)
    AND oo.ordered_at < $2::timestamp
    AND oo.cancelled_at IS NULL
)
SELECT COALESCE(SUM(total_cents), 0) AS oms_row,
       COALESCE(SUM(total_cents) FILTER (WHERE NOT accepted), 0) AS not_accepted,
       COUNT(*) FILTER (WHERE NOT accepted) AS not_accepted_orders
FROM oms_row`);

// ── VENDORS_SQL (contract §2.11) ────────────────────────────────────────

/**
 * One row per vendor that ordered, moved money in the period or holds a
 * balance, from the same order CTE and ledger rules as the page, so the
 * vendor table ties to it. Parameters ORDER_CTE_PARAMS.
 */
export function vendorsStatement(tables: FinanceRawTables): FinanceSqlStatement {
  return {
    params: ORDER_CTE_PARAMS,
    text: `
WITH ${orderEconomicsCte(tables)},
ko AS (
  SELECT vendor_id, COUNT(*) AS orders, SUM(total_debit_cents) AS billed,
         COUNT(*) FILTER (WHERE waiting_reason IS NOT NULL) AS waiting,
         SUM(total_debit_cents) FILTER (WHERE waiting_reason IS NULL) AS billed_fc,
         SUM(cogs_mills) FILTER (WHERE waiting_reason IS NULL) AS cogs_mills_fc,
         SUM(label_cents) FILTER (WHERE waiting_reason IS NULL) AS labels_fc,
         SUM(insurance_pool_cents) FILTER (WHERE waiting_reason IS NULL) AS pool_fc
  FROM classified GROUP BY vendor_id
),
${ledgerRowsCte("$3")},
moved AS (
  SELECT lx.*, (lx.status = 'settled' AND lx.moved_at >= $1::timestamptz AND lx.moved_at < $2::timestamptz) AS in_p
  FROM lx
),
led AS (
  SELECT m.vendor_id,
         COALESCE(SUM(${sqlInt("m.metadata->>'cardFeeCents'")}) FILTER (WHERE m.in_p AND m.type = 'funding'), 0)
           - COALESCE(SUM(m.amount_cents) FILTER (WHERE m.in_p AND m.type IN ('advance_fee', 'return_fee')), 0) AS fees,
         COALESCE(SUM(m.amount_cents) FILTER (WHERE m.in_p AND m.type = 'return_credit'), 0) AS credits_cs,
         COALESCE(SUM(m.amount_cents) FILTER (WHERE m.in_p AND m.type IN ('return_credit', 'insurance_pool_credit')), 0) AS credits_all,
         COALESCE(SUM(COALESCE(${sqlInt("m.metadata->>'chargedCents'")}, m.amount_cents))
                  FILTER (WHERE m.in_p AND m.type = 'funding' AND m.cash_line <> 'manual'), 0) AS cash_in,
         COUNT(*) FILTER (WHERE m.in_p) AS moved
  FROM moved m GROUP BY m.vendor_id
),
acc AS (
  SELECT vendor_id, available_balance_cents::bigint AS available, pending_balance_cents::bigint AS pending,
         rewards_balance_cents::bigint AS points
  FROM dropship.dropship_wallet_accounts
)
SELECT vd.id AS vendor_id, vd.business_name, vd.contact_name, vd.status,
       COALESCE(ko.orders, 0) AS orders, COALESCE(ko.billed, 0) AS billed, COALESCE(ko.waiting, 0) AS waiting,
       COALESCE(ko.billed_fc, 0) AS billed_fc, COALESCE(ko.cogs_mills_fc, 0) AS cogs_mills_fc,
       COALESCE(ko.labels_fc, 0) AS labels_fc, COALESCE(ko.pool_fc, 0) AS pool_fc,
       COALESCE(led.fees, 0) AS fees, COALESCE(led.credits_cs, 0) AS credits_cs, COALESCE(led.credits_all, 0) AS credits_all,
       COALESCE(led.cash_in, 0) AS cash_in,
       acc.available, acc.pending, acc.points
FROM dropship.dropship_vendors vd
LEFT JOIN ko ON ko.vendor_id = vd.id
LEFT JOIN led ON led.vendor_id = vd.id
LEFT JOIN acc ON acc.vendor_id = vd.id
WHERE ${vendorFilter("vd.id", "$3")}
  AND (ko.vendor_id IS NOT NULL OR COALESCE(led.moved, 0) > 0
       OR acc.available <> 0 OR acc.pending <> 0 OR acc.points <> 0)
ORDER BY vd.id`,
  };
}

// ── reconciliation checks (contract §3) ─────────────────────────────────

/**
 * Every check's item SQL returns the same columns, so the summary can count
 * them and the rows list (part 2) can page them:
 * item_kind, item_id, vendor_id, intake_id, detail_key,
 * expected_cents, found_cents, difference_cents, is_exception.
 * is_exception is never NULL: an item the SQL cannot decide is an exception
 * (fail closed). difference_cents is NULL when the item is not about money.
 */
export function checkCountsSql(itemsSql: string): string {
  return `
SELECT COUNT(*) AS examined,
       COUNT(*) FILTER (WHERE x.is_exception) AS exceptions,
       SUM(ABS(x.difference_cents)) FILTER (WHERE x.is_exception) AS difference
FROM (${itemsSql}
) x`;
}

export interface FinanceCheckSql {
  readonly id: FinanceSqlCheckId;
  /** Tables the check cannot run without; one missing makes it "could not check" (table_missing). */
  readonly requires: readonly FinanceTableKey[];
  /** Program-only checks are not run in a vendor's view (the builder reports "program_wide"). */
  readonly programOnly: boolean;
  /** The item SQL (not yet wrapped in checkCountsSql) and its parameters. */
  build(flags: FinanceSqlFlags): FinanceSqlStatement;
}

const LEDGER = "dropship.dropship_wallet_ledger";
const ACCOUNTS = "dropship.dropship_wallet_accounts";
const ECONOMICS = "dropship.dropship_order_economics_snapshots";
const ORDER_TABLES: readonly FinanceTableKey[] = [
  "economics", "oms_orders", "oms_lines", "costs", "wms_orders", "wms_items", "shipments", "shipment_items", "ledger",
];
const fixed = (params: readonly FinanceSqlParam[], text: string) => (): FinanceSqlStatement => ({ params, text });

/** W1: each wallet's available balance equals Σ its settled balance-moving entries (recon 1). $1 vendor. */
const W1_SQL = `
WITH s AS (
  SELECT l.vendor_id, SUM(l.amount_cents)::bigint AS cents
  FROM ${LEDGER} l
  WHERE l.status = 'settled' AND l.type IN (${AVAILABLE_TYPES_SQL}) AND ${vendorFilter("l.vendor_id", "$1")}
  GROUP BY l.vendor_id
)
SELECT 'wallet'::text AS item_kind, a.id::text AS item_id, a.vendor_id, NULL::integer AS intake_id,
       'balance_matches_history'::text AS detail_key,
       a.available_balance_cents::bigint AS expected_cents, COALESCE(s.cents, 0)::bigint AS found_cents,
       (COALESCE(s.cents, 0) - a.available_balance_cents::bigint) AS difference_cents,
       COALESCE(a.available_balance_cents::bigint <> COALESCE(s.cents, 0), true) AS is_exception
FROM ${ACCOUNTS} a
LEFT JOIN s ON s.vendor_id = a.vendor_id
WHERE ${vendorFilter("a.vendor_id", "$1")}
UNION ALL
SELECT 'ledger_vendor', s.vendor_id::text, s.vendor_id, NULL::integer, 'history_without_wallet',
       0::bigint, s.cents, s.cents, true
FROM s
WHERE NOT EXISTS (SELECT 1 FROM ${ACCOUNTS} a WHERE a.vendor_id = s.vendor_id)`;

/** W2: each wallet's on-the-way balance equals its pending deposits (recon 2). $1 vendor. */
const W2_SQL = `
WITH s AS (
  SELECT l.vendor_id, SUM(l.amount_cents)::bigint AS cents
  FROM ${LEDGER} l
  WHERE l.type = 'funding' AND l.status = 'pending' AND ${vendorFilter("l.vendor_id", "$1")}
  GROUP BY l.vendor_id
)
SELECT 'wallet'::text AS item_kind, a.id::text AS item_id, a.vendor_id, NULL::integer AS intake_id,
       'on_the_way_matches_pending_deposits'::text AS detail_key,
       a.pending_balance_cents::bigint AS expected_cents, COALESCE(s.cents, 0)::bigint AS found_cents,
       (COALESCE(s.cents, 0) - a.pending_balance_cents::bigint) AS difference_cents,
       COALESCE(a.pending_balance_cents::bigint <> COALESCE(s.cents, 0), true) AS is_exception
FROM ${ACCOUNTS} a
LEFT JOIN s ON s.vendor_id = a.vendor_id
WHERE ${vendorFilter("a.vendor_id", "$1")}
UNION ALL
SELECT 'ledger_vendor', s.vendor_id::text, s.vendor_id, NULL::integer, 'pending_without_wallet',
       0::bigint, s.cents, s.cents, true
FROM s
WHERE NOT EXISTS (SELECT 1 FROM ${ACCOUNTS} a WHERE a.vendor_id = s.vendor_id)`;

/** W3: each wallet's points equal its settled points history and its lots (recon 3). Points are not money. $1 vendor. */
const W3_SQL = `
WITH r AS (
  SELECT l.vendor_id, SUM(l.amount_cents)::bigint AS points
  FROM ${LEDGER} l
  WHERE l.status = 'settled' AND l.type IN (${REWARDS_TYPES_SQL}) AND ${vendorFilter("l.vendor_id", "$1")}
  GROUP BY l.vendor_id
),
lt AS (
  SELECT lot.wallet_account_id, SUM(lot.remaining_cents)::bigint AS points
  FROM dropship.dropship_wallet_rewards_lots lot
  GROUP BY lot.wallet_account_id
)
SELECT 'wallet'::text AS item_kind, a.id::text AS item_id, a.vendor_id, NULL::integer AS intake_id,
       'points_match_history_and_lots'::text AS detail_key,
       a.rewards_balance_cents::bigint AS expected_cents, COALESCE(r.points, 0)::bigint AS found_cents,
       NULL::bigint AS difference_cents,
       COALESCE(a.rewards_balance_cents::bigint <> COALESCE(r.points, 0)
             OR a.rewards_balance_cents::bigint <> COALESCE(lt.points, 0), true) AS is_exception
FROM ${ACCOUNTS} a
LEFT JOIN r ON r.vendor_id = a.vendor_id
LEFT JOIN lt ON lt.wallet_account_id = a.id
WHERE ${vendorFilter("a.vendor_id", "$1")}
UNION ALL
SELECT 'ledger_vendor', r.vendor_id::text, r.vendor_id, NULL::integer, 'points_without_wallet',
       0::bigint, r.points, NULL::bigint, true
FROM r
WHERE NOT EXISTS (SELECT 1 FROM ${ACCOUNTS} a WHERE a.vendor_id = r.vendor_id)`;

/**
 * W4: for every wallet, balance before the start + the period's movements =
 * balance before the end; and, when the period ends now, that end equals the
 * wallet now (recon 1 walk). $1/$2 period, $3 vendor.
 */
function w4Sql(flags: FinanceSqlFlags): FinanceSqlStatement {
  const endMatchesWallet = flags.endsNow
    ? `
UNION ALL
SELECT 'wallet', a.id::text, a.vendor_id, NULL::integer, 'end_matches_wallet',
       a.available_balance_cents::bigint, COALESCE(v.before_end, 0),
       COALESCE(v.before_end, 0) - a.available_balance_cents::bigint,
       COALESCE(a.available_balance_cents::bigint <> COALESCE(v.before_end, 0), true)
FROM ${ACCOUNTS} a
LEFT JOIN v ON v.vendor_id = a.vendor_id
WHERE ${vendorFilter("a.vendor_id", "$3")}`
    : "";
  return {
    params: ["startBound", "endBound", "vendorId"],
    text: `
WITH f AS (
  SELECT l.vendor_id, l.amount_cents::bigint AS amount_cents, l.settled_at,
         CASE WHEN l.type = 'funding' THEN l.settled_at ELSE l.created_at END AS moved_at
  FROM ${LEDGER} l
  WHERE l.status = 'settled' AND l.type IN (${AVAILABLE_TYPES_SQL}) AND ${vendorFilter("l.vendor_id", "$3")}
),
v AS (
  SELECT f.vendor_id,
         COALESCE(SUM(f.amount_cents) FILTER (WHERE f.settled_at < $1::timestamptz), 0)::bigint AS before_start,
         COALESCE(SUM(f.amount_cents) FILTER (WHERE f.moved_at >= $1::timestamptz AND f.moved_at < $2::timestamptz), 0)::bigint AS moved,
         COALESCE(SUM(f.amount_cents) FILTER (WHERE f.settled_at < $2::timestamptz), 0)::bigint AS before_end
  FROM f GROUP BY f.vendor_id
)
SELECT 'wallet_walk'::text AS item_kind, v.vendor_id::text AS item_id, v.vendor_id, NULL::integer AS intake_id,
       'walk_closes'::text AS detail_key,
       v.before_end AS expected_cents, (v.before_start + v.moved) AS found_cents,
       (v.before_start + v.moved - v.before_end) AS difference_cents,
       COALESCE(v.before_start + v.moved <> v.before_end, true) AS is_exception
FROM v${endMatchesWallet}`,
  };
}

const debitInt = (path: string) => sqlInt(`d.metadata${path}`);

/** O1: wallet + points payments, the OMS total and the recorded total all equal what we billed (recon 4). ORDER_CTE_PARAMS. */
const O1_SQL = `
WITH ${ECON_CTE}
SELECT 'order'::text AS item_kind, e.intake_id::text AS item_id, e.vendor_id, e.intake_id,
       'payments_match_billed'::text AS detail_key,
       e.total_debit_cents AS expected_cents,
       (-(COALESCE(d.amount_cents::bigint, 0) + COALESCE(r.amount_cents::bigint, 0))) AS found_cents,
       (-(COALESCE(d.amount_cents::bigint, 0) + COALESCE(r.amount_cents::bigint, 0)) - e.total_debit_cents) AS difference_cents,
       COALESCE(
            (d.id IS NULL AND r.id IS NULL)
         OR -(COALESCE(d.amount_cents::bigint, 0) + COALESCE(r.amount_cents::bigint, 0)) <> e.total_debit_cents
         OR oo.total_cents::bigint IS DISTINCT FROM e.total_debit_cents
         -- the recorded totals exist from 2026-09-24 (missingMovements[9]); absent is skipped, unreadable is not
         OR ((d.metadata->>'totalDebitCents') IS NOT NULL AND ${debitInt("->>'totalDebitCents'")} IS DISTINCT FROM e.total_debit_cents)
         OR ((r.metadata->>'totalDebitCents') IS NOT NULL AND ${sqlInt("r.metadata->>'totalDebitCents'")} IS DISTINCT FROM e.total_debit_cents)
         OR ((COALESCE(${debitInt("->'advance'->>'feeCents'")}, 0) > 0 OR f.id IS NOT NULL)
             AND (-f.amount_cents::bigint) IS DISTINCT FROM ${debitInt("->'advance'->>'feeCents'")}),
         true) AS is_exception
FROM econ e
LEFT JOIN oms.oms_orders oo ON oo.id = e.oms_order_id
LEFT JOIN ${LEDGER} d ON d.reference_type = 'order_intake' AND d.reference_id = e.intake_id::text
LEFT JOIN ${LEDGER} r ON r.reference_type = 'order_intake_rewards' AND r.reference_id = e.intake_id::text
LEFT JOIN ${LEDGER} f ON f.reference_type = 'order_intake_advance_fee' AND f.reference_id = e.intake_id::text`;

/** O2: what we billed = product + shipping, and the fees field is zero (recon 5). ORDER_CTE_PARAMS. */
const O2_SQL = `
WITH ${ECON_CTE}
SELECT 'order'::text AS item_kind, e.intake_id::text AS item_id, e.vendor_id, e.intake_id,
       'billed_is_product_plus_shipping'::text AS detail_key,
       e.total_debit_cents AS expected_cents,
       (e.wholesale_subtotal_cents + e.shipping_cents + e.fees_cents) AS found_cents,
       (e.wholesale_subtotal_cents + e.shipping_cents + e.fees_cents - e.total_debit_cents) AS difference_cents,
       COALESCE(e.total_debit_cents <> e.wholesale_subtotal_cents + e.shipping_cents + e.fees_cents
             OR e.fees_cents <> 0, true) AS is_exception
FROM econ e`;

/** O3: shipping = its quote = base + markup + packaging (0) + pool share (recon 6). ORDER_CTE_PARAMS. */
const O3_SQL = `
WITH ${ECON_CTE}
SELECT 'order'::text AS item_kind, e.intake_id::text AS item_id, e.vendor_id, e.intake_id,
       'shipping_is_its_quote'::text AS detail_key,
       e.shipping_cents AS expected_cents, q.total_shipping_cents::bigint AS found_cents,
       (q.total_shipping_cents::bigint - e.shipping_cents) AS difference_cents,
       COALESCE(q.id IS NULL
             OR e.shipping_cents <> q.total_shipping_cents::bigint
             OR q.total_shipping_cents::bigint <> q.base_rate_cents::bigint + q.markup_cents::bigint
                                                 + q.dunnage_cents::bigint + q.insurance_pool_cents::bigint
             OR e.insurance_pool_cents <> q.insurance_pool_cents::bigint
             OR q.dunnage_cents::bigint <> 0, true) AS is_exception
FROM econ e
LEFT JOIN dropship.dropship_shipping_quote_snapshots q ON q.id = e.shipping_quote_snapshot_id`;

const PRICED_LINES = `jsonb_array_elements(CASE WHEN jsonb_typeof(e.pricing_snapshot->'wholesale'->'lines') = 'array'
                                    THEN e.pricing_snapshot->'wholesale'->'lines' ELSE '[]'::jsonb END) AS x(line)`;

/** O4: product billed = OMS subtotal = Σ OMS lines = Σ priced lines; shipping = OMS shipping; no OMS tax or discount (recon 7). */
const O4_SQL = `
WITH ${ECON_CTE}
SELECT 'order'::text AS item_kind, e.intake_id::text AS item_id, e.vendor_id, e.intake_id,
       'product_matches_oms_and_priced_lines'::text AS detail_key,
       e.wholesale_subtotal_cents AS expected_cents, oo.subtotal_cents::bigint AS found_cents,
       (oo.subtotal_cents::bigint - e.wholesale_subtotal_cents) AS difference_cents,
       COALESCE(oo.id IS NULL
             OR oo.subtotal_cents::bigint IS DISTINCT FROM e.wholesale_subtotal_cents
             OR ln.cents IS DISTINCT FROM e.wholesale_subtotal_cents
             OR sn.cents IS DISTINCT FROM e.wholesale_subtotal_cents
             OR sn.unreadable > 0
             OR oo.shipping_cents::bigint IS DISTINCT FROM e.shipping_cents
             OR COALESCE(oo.tax_cents::bigint, 0) <> 0
             OR COALESCE(oo.discount_cents::bigint, 0) <> 0, true) AS is_exception
FROM econ e
LEFT JOIN oms.oms_orders oo ON oo.id = e.oms_order_id
LEFT JOIN LATERAL (
  SELECT SUM(ol.total_price_cents::bigint)::bigint AS cents FROM oms.oms_order_lines ol WHERE ol.order_id = e.oms_order_id
) ln ON true
LEFT JOIN LATERAL (
  SELECT SUM(${sqlInt("x.line->>'wholesaleLineTotalCents'")})::bigint AS cents,
         COUNT(*) FILTER (WHERE ${sqlInt("x.line->>'wholesaleLineTotalCents'")} IS NULL) AS unreadable
  FROM ${PRICED_LINES}
) sn ON true`;

/**
 * O5: every accepted order is accepted on its intake at the same instant,
 * charged at that instant and paid in OMS; and every intake accepted in the
 * period has its economics row (recon 8, C11). ORDER_CTE_PARAMS.
 */
const O5_SQL = `
WITH ${ECON_CTE}
SELECT 'order'::text AS item_kind, e.intake_id::text AS item_id, e.vendor_id, e.intake_id,
       'accepted_charged_and_paid_together'::text AS detail_key,
       NULL::bigint AS expected_cents, NULL::bigint AS found_cents, NULL::bigint AS difference_cents,
       COALESCE(i.id IS NULL OR i.status <> 'accepted'
             OR i.accepted_at IS DISTINCT FROM e.accepted_at
             OR (d.id IS NOT NULL AND d.created_at <> e.accepted_at)
             OR (r.id IS NOT NULL AND r.created_at <> e.accepted_at)
             OR oo.id IS NULL OR oo.financial_status IS DISTINCT FROM 'paid'
             OR e.oms_order_id IS NULL OR i.oms_order_id IS DISTINCT FROM e.oms_order_id, true) AS is_exception
FROM econ e
LEFT JOIN dropship.dropship_order_intake i ON i.id = e.intake_id
LEFT JOIN oms.oms_orders oo ON oo.id = e.oms_order_id
LEFT JOIN ${LEDGER} d ON d.reference_type = 'order_intake' AND d.reference_id = e.intake_id::text
LEFT JOIN ${LEDGER} r ON r.reference_type = 'order_intake_rewards' AND r.reference_id = e.intake_id::text
UNION ALL
SELECT 'intake', i.id::text, i.vendor_id, i.id, 'accepted_without_economics',
       NULL::bigint, NULL::bigint, NULL::bigint, true
FROM dropship.dropship_order_intake i
WHERE i.status = 'accepted' AND i.accepted_at >= $1::timestamptz AND i.accepted_at < $2::timestamptz
  AND ${vendorFilter("i.vendor_id", "$3")}
  AND ($4::integer IS NULL OR i.id = $4::integer)
  AND NOT EXISTS (SELECT 1 FROM ${ECONOMICS} x WHERE x.intake_id = i.id)`;

/** O6: OMS packs = priced packs = the buyer's packs, and no order shipped more than it accepted (recon 19). Packs, not money. */
function o6Sql(flags: FinanceSqlFlags): FinanceSqlStatement {
  const quantity = (alias: string) => sqlInt(`${alias}.line->>'quantity'`);
  return {
    params: ORDER_CTE_PARAMS,
    text: `
WITH ${orderEconomicsCte(flags.tables)},
snap AS (
  SELECT e.econ_id, SUM(${quantity("x")}) AS packs, COUNT(*) FILTER (WHERE ${quantity("x")} IS NULL) AS unreadable
  FROM econ e CROSS JOIN LATERAL ${PRICED_LINES}
  GROUP BY e.econ_id
),
buyer AS (
  SELECT e.econ_id, SUM(${quantity("y")}) AS packs, COUNT(*) FILTER (WHERE ${quantity("y")} IS NULL) AS unreadable
  FROM econ e
  JOIN dropship.dropship_order_intake i ON i.id = e.intake_id
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(i.normalized_payload->'lines') = 'array'
                                               THEN i.normalized_payload->'lines' ELSE '[]'::jsonb END) AS y(line)
  GROUP BY e.econ_id
)
SELECT 'order'::text AS item_kind, c.intake_id::text AS item_id, c.vendor_id, c.intake_id,
       'packs_agree'::text AS detail_key,
       c.ordered_packs AS expected_cents, c.shipped_packs AS found_cents, NULL::bigint AS difference_cents,
       COALESCE(c.ordered_packs IS DISTINCT FROM s.packs OR COALESCE(s.unreadable, 0) > 0
             OR c.ordered_packs IS DISTINCT FROM b.packs OR COALESCE(b.unreadable, 0) > 0
             OR c.shipped_packs > c.ordered_packs, true) AS is_exception
FROM classified c
LEFT JOIN snap s ON s.econ_id = c.econ_id
LEFT JOIN buyer b ON b.econ_id = c.econ_id`,
  };
}

/**
 * D1: a deposit settled in the period with a charged amount = credit + card
 * fee; and every top-up run linked to such a deposit agrees with it. Runs are
 * never added to totals (recon 11). $1/$2 period, $3 vendor.
 */
function d1Sql(flags: FinanceSqlFlags): FinanceSqlStatement {
  const runs = flags.tables.maintenance_runs
    ? `
UNION ALL
SELECT 'maintenance_run', mr.id::text, mr.vendor_id, NULL::integer, 'run_matches_its_deposit',
       mr.charged_cents::bigint, (mr.amount_cents::bigint + COALESCE(mr.card_fee_cents::bigint, 0)),
       (mr.amount_cents::bigint + COALESCE(mr.card_fee_cents::bigint, 0) - mr.charged_cents::bigint),
       COALESCE(mr.charged_cents::bigint IS DISTINCT FROM mr.amount_cents::bigint + COALESCE(mr.card_fee_cents::bigint, 0)
             OR mr.amount_cents::bigint IS DISTINCT FROM l.amount_cents::bigint, true)
FROM dropship.dropship_wallet_maintenance_runs mr
JOIN ${LEDGER} l ON l.id = mr.wallet_ledger_entry_id
WHERE l.type = 'funding' AND l.status = 'settled'
  AND l.settled_at >= $1::timestamptz AND l.settled_at < $2::timestamptz
  AND ${vendorFilter("l.vendor_id", "$3")}`
    : "";
  const chargedCents = sqlInt("l.metadata->>'chargedCents'");
  const cardFeeCents = sqlInt("l.metadata->>'cardFeeCents'");
  return {
    params: ["startBound", "endBound", "vendorId"],
    text: `
SELECT 'ledger_entry'::text AS item_kind, l.id::text AS item_id, l.vendor_id, NULL::integer AS intake_id,
       'charged_is_credit_plus_fee'::text AS detail_key,
       ${chargedCents} AS expected_cents,
       (l.amount_cents::bigint + COALESCE(${cardFeeCents}, 0)) AS found_cents,
       (l.amount_cents::bigint + COALESCE(${cardFeeCents}, 0) - ${chargedCents}) AS difference_cents,
       COALESCE(${chargedCents} IS DISTINCT FROM l.amount_cents::bigint + COALESCE(${cardFeeCents}, 0), true) AS is_exception
FROM ${LEDGER} l
WHERE l.type = 'funding' AND l.status = 'settled'
  AND l.settled_at >= $1::timestamptz AND l.settled_at < $2::timestamptz
  AND ${vendorFilter("l.vendor_id", "$3")}
  AND (l.metadata->>'chargedCents') IS NOT NULL${runs}`,
  };
}

/**
 * D2: every points grant in the period belongs to a settled deposit, matches
 * that deposit times its rate (floor, as calculateRewardsEarnedCents), and no
 * deposit has two grants (recon 12). Points, not money. $1/$2 period, $3 vendor.
 */
const rateBps = `(CASE WHEN (r.metadata->>'rateBps') ~ ${RATE_TEXT} THEN (r.metadata->>'rateBps')::bigint END)`;
const D2_SQL = `
WITH dups AS (
  SELECT r2.reference_id FROM ${LEDGER} r2
  WHERE r2.type = 'rewards_earned'
  GROUP BY r2.reference_id HAVING COUNT(*) > 1
)
SELECT 'ledger_entry'::text AS item_kind, r.id::text AS item_id, r.vendor_id, NULL::integer AS intake_id,
       'points_follow_the_rate'::text AS detail_key,
       ((fu.amount_cents::bigint * ${rateBps}) / ${BPS_PER_WHOLE}) AS expected_cents,
       r.amount_cents::bigint AS found_cents, NULL::bigint AS difference_cents,
       COALESCE(fu.id IS NULL OR fu.type <> 'funding' OR fu.status <> 'settled'
             OR ${sqlInt("r.metadata->>'creditAmountCents'")} IS DISTINCT FROM fu.amount_cents::bigint
             OR r.amount_cents::bigint IS DISTINCT FROM (fu.amount_cents::bigint * ${rateBps}) / ${BPS_PER_WHOLE}
             OR r.reference_id IN (SELECT reference_id FROM dups), true) AS is_exception
FROM ${LEDGER} r
LEFT JOIN ${LEDGER} fu ON fu.id = ${sqlIntId("r.reference_id")}
WHERE r.type = 'rewards_earned' AND r.status = 'settled'
  AND r.created_at >= $1::timestamptz AND r.created_at < $2::timestamptz
  AND ${vendorFilter("r.vendor_id", "$3")}`;

/**
 * D3: every pull-back in the period pairs with its deposit, and when won
 * with its win; the points rows pair too, and no pull-back takes more cash
 * than its deposit gave. Disputes not won back are listed, not exceptions
 * (recon 13). $1/$2 period, $3 vendor.
 */
const D3_SQL = `
SELECT 'ledger_entry'::text AS item_kind, rv.id::text AS item_id, rv.vendor_id, NULL::integer AS intake_id,
       CASE WHEN ri.id IS NULL THEN 'not_won_back' ELSE 'pull_back_pairs_with_win' END AS detail_key,
       (-rv.amount_cents::bigint) AS expected_cents, ri.amount_cents::bigint AS found_cents,
       (ri.amount_cents::bigint + rv.amount_cents::bigint) AS difference_cents,
       COALESCE(fu.id IS NULL
             OR (ri.id IS NOT NULL AND ri.amount_cents::bigint <> -rv.amount_cents::bigint)
             OR (rri.id IS NOT NULL AND (rr.id IS NULL OR rri.amount_cents::bigint <> -rr.amount_cents::bigint))
             OR (-rv.amount_cents::bigint - COALESCE(${sqlInt("rv.metadata->'rewardsClawback'->>'fromCashCents'")}, 0))
                > fu.amount_cents::bigint, true) AS is_exception
FROM ${LEDGER} rv
LEFT JOIN ${LEDGER} ri ON ri.type = 'funding_reinstated' AND ri.reference_type = 'stripe_dispute_reinstated' AND ri.reference_id = rv.reference_id
LEFT JOIN ${LEDGER} rr ON rr.type = 'rewards_reversed' AND rr.reference_type = 'stripe_dispute_rewards' AND rr.reference_id = rv.reference_id
LEFT JOIN ${LEDGER} rri ON rri.type = 'rewards_reinstated' AND rri.reference_type = 'stripe_dispute_rewards_reinstated' AND rri.reference_id = rv.reference_id
LEFT JOIN ${LEDGER} fu ON fu.id = ${sqlIntId("rv.metadata->>'fundingLedgerEntryId'")}
WHERE rv.type = 'funding_reversal' AND rv.status = 'settled'
  AND rv.created_at >= $1::timestamptz AND rv.created_at < $2::timestamptz
  AND ${vendorFilter("rv.vendor_id", "$3")}`;

/**
 * D4: every USDC deposit created or settled in the period has exactly one
 * chain record, the same amount and a matching status; and no transfer is
 * credited twice (recon 14). The chain record's identity is (chain, hash,
 * log index) (migration 0691): two credited logs of one transaction are two
 * transfers; a credit with no log index next to any other credit of the same
 * transaction is a double credit (a staff credit and the watcher's).
 * $1/$2 period, $3 vendor.
 */
const D4_SQL = `
WITH u AS (
  SELECT l.id, l.vendor_id, l.status, l.amount_cents::bigint AS amount_cents,
         COUNT(x.id) AS chain_rows,
         MIN(div(x.amount_atomic_units, ${USDC_ATOMIC_UNITS_PER_CENT}))::bigint AS chain_cents,
         MIN(x.status) AS chain_status
  FROM ${LEDGER} l
  LEFT JOIN dropship.dropship_usdc_ledger_entries x ON x.wallet_ledger_id = l.id
  WHERE l.type = 'funding' AND l.reference_type = 'usdc_base_transaction'
    AND ${vendorFilter("l.vendor_id", "$3")}
    AND ((l.created_at >= $1::timestamptz AND l.created_at < $2::timestamptz)
      OR (l.settled_at >= $1::timestamptz AND l.settled_at < $2::timestamptz))
  GROUP BY l.id, l.vendor_id, l.status, l.amount_cents
),
transfers AS (
  SELECT x.chain_id, lower(x.transaction_hash) AS tx_hash,
         COUNT(*) FILTER (WHERE x.wallet_ledger_id IS NOT NULL) AS credited,
         COUNT(*) FILTER (WHERE x.wallet_ledger_id IS NOT NULL AND x.log_index IS NULL) AS credited_without_log,
         COUNT(DISTINCT x.log_index) FILTER (WHERE x.wallet_ledger_id IS NOT NULL AND x.log_index IS NOT NULL) AS credited_logs
  FROM dropship.dropship_usdc_ledger_entries x
  WHERE ${vendorFilter("x.vendor_id", "$3")}
  GROUP BY x.chain_id, lower(x.transaction_hash)
)
SELECT 'ledger_entry'::text AS item_kind, u.id::text AS item_id, u.vendor_id, NULL::integer AS intake_id,
       'one_chain_record_same_amount'::text AS detail_key,
       u.amount_cents AS expected_cents, u.chain_cents AS found_cents, (u.chain_cents - u.amount_cents) AS difference_cents,
       COALESCE(u.chain_rows <> 1 OR u.amount_cents <> u.chain_cents
             OR NOT ((u.status, u.chain_status) IN (('pending', 'pending'), ('settled', 'settled'), ('failed', 'voided'))), true) AS is_exception
FROM u
UNION ALL
SELECT 'chain_transfer', t.chain_id::text || ':' || t.tx_hash, NULL::integer, NULL::integer, 'credited_twice',
       NULL::bigint, NULL::bigint, NULL::bigint, true
FROM transfers t
WHERE t.credited > 1 AND (t.credited_without_log > 0 OR t.credited_logs < t.credited)`;

/** D5: every successful weekly collection has its deposit, marked as a collection, for the same amount (recon 20). $1 vendor. */
const D5_SQL = `
SELECT 'collection_attempt'::text AS item_kind, ca.id::text AS item_id, ca.vendor_id, NULL::integer AS intake_id,
       'collection_has_its_deposit'::text AS detail_key,
       ca.amount_cents::bigint AS expected_cents, l.amount_cents::bigint AS found_cents,
       (l.amount_cents::bigint - ca.amount_cents::bigint) AS difference_cents,
       COALESCE(l.id IS NULL OR l.type <> 'funding'
             OR (l.metadata->>'collection') IS DISTINCT FROM 'true'
             OR l.amount_cents::bigint <> ca.amount_cents::bigint, true) AS is_exception
FROM dropship.dropship_collection_attempts ca
LEFT JOIN ${LEDGER} l ON l.id = ca.wallet_ledger_entry_id
WHERE ca.status = 'succeeded' AND ${vendorFilter("ca.vendor_id", "$1")}`;

/**
 * D6: no deposit still on the way more than FINANCE_STALE_PENDING_DEPOSIT_DAYS
 * after it was sent, and every deposit has a way paid (recon 21). Examines
 * every deposit. $1 vendor, $2 now.
 */
const D6_SQL = `
WITH ${ledgerRowsCte("$1")}
SELECT 'ledger_entry'::text AS item_kind, lx.id::text AS item_id, lx.vendor_id, NULL::integer AS intake_id,
       CASE WHEN lx.cash_line = 'unknown' THEN 'no_way_paid' ELSE 'not_waiting_too_long' END AS detail_key,
       NULL::bigint AS expected_cents, lx.amount_cents AS found_cents, NULL::bigint AS difference_cents,
       COALESCE((lx.status = 'pending'
                 AND lx.created_at < $2::timestamptz - interval '${FINANCE_STALE_PENDING_DEPOSIT_DAYS} days')
             OR lx.cash_line = 'unknown', true) AS is_exception
FROM lx
WHERE lx.type = 'funding'`;

/**
 * D7: every amount stored in a deposit's or a pull-back's details reads as
 * whole cents; every failed deposit dated in the period, or not dated at all,
 * has its failure time; and every win in the period pairs with its pull-back.
 * $1/$2 period, $3 vendor, $4/$5 the period as ISO text.
 */
const D7_SQL = `
SELECT 'ledger_entry'::text AS item_kind, l.id::text AS item_id, l.vendor_id, NULL::integer AS intake_id,
       'amounts_are_whole_cents'::text AS detail_key,
       NULL::bigint AS expected_cents, NULL::bigint AS found_cents, NULL::bigint AS difference_cents,
       COALESCE(${sqlBad("l.metadata->>'chargedCents'")} OR ${sqlBad("l.metadata->>'cardFeeCents'")}
             OR ${sqlBad("l.metadata->>'disputeAmountCents'")} OR ${sqlBad("l.metadata->'rewardsClawback'->>'fromCashCents'")}
             OR (l.type = 'funding_reversal' AND ${sqlInt("l.metadata->>'disputeAmountCents'")} IS NULL), true) AS is_exception
FROM ${LEDGER} l
WHERE l.status = 'settled' AND l.type IN ('funding', 'funding_reversal')
  AND (CASE WHEN l.type = 'funding' THEN l.settled_at ELSE l.created_at END) >= $1::timestamptz
  AND (CASE WHEN l.type = 'funding' THEN l.settled_at ELSE l.created_at END) < $2::timestamptz
  AND ${vendorFilter("l.vendor_id", "$3")}
UNION ALL
SELECT 'ledger_entry', l.id::text, l.vendor_id, NULL::integer, 'failure_time_recorded',
       NULL::bigint, NULL::bigint, NULL::bigint,
       NOT COALESCE((l.metadata->'failure'->>'failedAt') ~ ${ISO_INSTANT_TEXT}, false)
FROM ${LEDGER} l
WHERE l.type = 'funding' AND l.status = 'failed' AND ${vendorFilter("l.vendor_id", "$3")}
  AND (NOT COALESCE((l.metadata->'failure'->>'failedAt') ~ ${ISO_INSTANT_TEXT}, false)
       OR ((l.metadata->'failure'->>'failedAt') COLLATE "C" >= $4::text
           AND (l.metadata->'failure'->>'failedAt') COLLATE "C" < $5::text))
UNION ALL
SELECT 'ledger_entry', ri.id::text, ri.vendor_id, NULL::integer, 'win_pairs_with_pull_back',
       NULL::bigint, NULL::bigint, NULL::bigint, (rv.id IS NULL)
FROM (SELECT x.id, x.vendor_id, x.reference_id, ${sqlIntId("x.metadata->>'reversalLedgerEntryId'")} AS reversal_id
      FROM ${LEDGER} x
      WHERE x.type = 'funding_reinstated' AND x.status = 'settled'
        AND x.created_at >= $1::timestamptz AND x.created_at < $2::timestamptz
        AND ${vendorFilter("x.vendor_id", "$3")}) ri
${PAIRED_REVERSAL}`;

/**
 * K1: a package's cost source matches its cost; voided packages holding a
 * cost are listed (not exceptions); every order's shipping split adds up to
 * its shipping (recon 17). ORDER_CTE_PARAMS.
 */
function k1Sql(flags: FinanceSqlFlags): FinanceSqlStatement {
  const allocations = flags.tables.allocations
    ? `
UNION ALL
SELECT 'order', e.intake_id::text, e.vendor_id, e.intake_id, 'shipping_split_adds_up',
       e.shipping_cents, a.allocated, (a.allocated - e.shipping_cents),
       COALESCE(a.allocated <> e.shipping_cents, true)
FROM econ e
JOIN (SELECT al.intake_id, SUM(al.allocated_shipping_charge_cents)::bigint AS allocated
      FROM dropship.dropship_shipment_shipping_allocations al
      WHERE al.intake_id IN (SELECT intake_id FROM econ)
      GROUP BY al.intake_id) a ON a.intake_id = e.intake_id`
    : "";
  return {
    params: ORDER_CTE_PARAMS,
    text: `
WITH ${orderEconomicsCte(flags.tables)}
SELECT 'package'::text AS item_kind, p.package_id::text AS item_id, e.vendor_id, e.intake_id,
       'cost_source_matches_cost'::text AS detail_key,
       NULL::bigint AS expected_cents, p.carrier_cost_cents AS found_cents, NULL::bigint AS difference_cents,
       ((p.carrier_cost_source IS NOT NULL) <> COALESCE(p.carrier_cost_cents > 0, false)) AS is_exception
FROM pkg p JOIN econ e ON e.econ_id = p.econ_id
UNION ALL
SELECT 'package', os.id::text, e.vendor_id, e.intake_id, 'voided_package_holds_cost',
       NULL::bigint, os.carrier_cost_cents::bigint, NULL::bigint, false
FROM wms_o w
JOIN econ e ON e.econ_id = w.econ_id
JOIN wms.outbound_shipments os ON os.order_id = w.wms_order_id
WHERE os.status IN (${VOIDED_PACKAGE_STATUSES}) AND COALESCE(os.carrier_cost_cents::bigint, 0) > 0${allocations}`,
  };
}

/**
 * K2: every cost row's total = packs × unit cost; every picked or shipped
 * line has a cost row; cost rows linked to no line of the order are listed as
 * exceptions (recon 18, C10). Mills, not cents. ORDER_CTE_PARAMS.
 */
function k2Sql(flags: FinanceSqlFlags): FinanceSqlStatement {
  return {
    params: ORDER_CTE_PARAMS,
    text: `
WITH ${orderEconomicsCte(flags.tables)},
item_lines AS (
  SELECT w.econ_id, oi.oms_order_line_id AS line_id, SUM(COALESCE(oi.picked_quantity, 0))::bigint AS picked
  FROM wms_o w JOIN wms.order_items oi ON oi.order_id = w.wms_order_id
  GROUP BY w.econ_id, oi.oms_order_line_id
),
shipped_lines AS (
  SELECT p.econ_id, oi.oms_order_line_id AS line_id, SUM(osi.qty)::bigint AS shipped
  FROM pkg p
  JOIN wms.outbound_shipment_items osi ON osi.shipment_id = p.package_id AND osi.shipment_item_purpose = 'customer_fulfillment'
  JOIN wms.order_items oi ON oi.id = osi.order_item_id
  GROUP BY p.econ_id, oi.oms_order_line_id
)
SELECT 'cost_row'::text AS item_kind, oic.id::text AS item_id, e.vendor_id, e.intake_id,
       'cost_row_adds_up'::text AS detail_key,
       (oic.qty::bigint * oic.unit_cost_mills::bigint) AS expected_cents, oic.total_cost_mills::bigint AS found_cents,
       NULL::bigint AS difference_cents,
       COALESCE(COALESCE(oic.total_cost_mills::bigint, 0) <> 0
                AND oic.total_cost_mills::bigint IS DISTINCT FROM oic.qty::bigint * oic.unit_cost_mills::bigint, true) AS is_exception
FROM wms_o w
JOIN econ e ON e.econ_id = w.econ_id
JOIN wms.order_items oi ON oi.order_id = w.wms_order_id
JOIN oms.order_item_costs oic ON oic.order_item_id = oi.id AND oic.order_id = oi.order_id
UNION ALL
SELECT 'order_line', l.line_id::text, e.vendor_id, e.intake_id, 'picked_or_shipped_has_cost',
       NULL::bigint, NULL::bigint, NULL::bigint,
       COALESCE((COALESCE(il.picked, 0) > 0 OR COALESCE(sl.shipped, 0) > 0)
                AND NOT EXISTS (SELECT 1 FROM cost_rows c WHERE c.econ_id = l.econ_id AND c.oms_order_line_id = l.line_id), true)
FROM lines l
JOIN econ e ON e.econ_id = l.econ_id
LEFT JOIN item_lines il ON il.econ_id = l.econ_id AND il.line_id = l.line_id
LEFT JOIN shipped_lines sl ON sl.econ_id = l.econ_id AND sl.line_id = l.line_id
UNION ALL
SELECT 'cost_row', c.cost_row_id::text, e.vendor_id, e.intake_id, 'cost_not_linked_to_a_line',
       NULL::bigint, NULL::bigint, NULL::bigint, true
FROM cost_rows c
JOIN econ e ON e.econ_id = c.econ_id
WHERE c.oms_order_line_id IS NULL
   OR NOT EXISTS (SELECT 1 FROM lines l WHERE l.econ_id = c.econ_id AND l.line_id = c.oms_order_line_id)`,
  };
}

/**
 * K3: no order accepted before now − FINANCE_COST_WAIT_ALERT_DAYS is still
 * waiting for its costs, in any period (C9). The repository passes
 * '-infinity' and that cut-off as the bounds. ORDER_CTE_PARAMS.
 */
function k3Sql(flags: FinanceSqlFlags): FinanceSqlStatement {
  return {
    params: ORDER_CTE_PARAMS,
    text: `
WITH ${orderEconomicsCte(flags.tables)}
SELECT 'order'::text AS item_kind, c.intake_id::text AS item_id, c.vendor_id, c.intake_id,
       COALESCE(c.waiting_reason, 'fully_costed') AS detail_key,
       NULL::bigint AS expected_cents, NULL::bigint AS found_cents, NULL::bigint AS difference_cents,
       (c.waiting_reason IS NOT NULL) AS is_exception
FROM classified c`,
  };
}

/**
 * R1: return settlements and inspections created in the period have the
 * wallet credit and fee they record; no order is credited by both return
 * paths; no order is credited more than it was billed (recon 16).
 * $1/$2 period, $3 vendor.
 */
const R1_SQL = `
WITH s AS (
  SELECT s.id, s.return_case_id, s.vendor_id, s.gross_credit_cents::bigint AS gross, s.total_fee_cents::bigint AS fee
  FROM returns.return_case_vendor_settlements s
  WHERE s.created_at >= $1::timestamptz AND s.created_at < $2::timestamptz AND ${vendorFilter("s.vendor_id", "$3")}
),
ins AS (
  SELECT ins.id, ins.rma_id, r.vendor_id, r.intake_id,
         COALESCE(ins.credit_cents, 0)::bigint AS credit, COALESCE(ins.fee_cents, 0)::bigint AS fee
  FROM dropship.dropship_rma_inspections ins
  JOIN dropship.dropship_rmas r ON r.id = ins.rma_id
  WHERE ins.created_at >= $1::timestamptz AND ins.created_at < $2::timestamptz AND ${vendorFilter("r.vendor_id", "$3")}
),
touched AS (
  SELECT e.intake_id, e.vendor_id, e.oms_order_id, e.total_debit_cents::bigint AS total_debit
  FROM ${ECONOMICS} e
  WHERE ${vendorFilter("e.vendor_id", "$3")}
    AND (e.intake_id IN (SELECT intake_id FROM ins)
         OR e.oms_order_id IN (SELECT rc.oms_order_id FROM s JOIN returns.return_cases rc ON rc.id = s.return_case_id))
),
credits AS (
  SELECT t.*, COALESCE(rma.cents, 0)::bigint AS rma_credits, COALESCE(cs.cents, 0)::bigint AS case_credits
  FROM touched t
  LEFT JOIN LATERAL (
    SELECT SUM(i2.credit_cents)::bigint AS cents
    FROM dropship.dropship_rmas r2 JOIN dropship.dropship_rma_inspections i2 ON i2.rma_id = r2.id
    WHERE r2.intake_id = t.intake_id
  ) rma ON true
  LEFT JOIN LATERAL (
    SELECT SUM(s2.gross_credit_cents)::bigint AS cents
    FROM returns.return_cases rc2 JOIN returns.return_case_vendor_settlements s2 ON s2.return_case_id = rc2.id
    WHERE rc2.oms_order_id = t.oms_order_id
  ) cs ON true
)
SELECT 'return_settlement'::text AS item_kind, s.id::text AS item_id, s.vendor_id, NULL::integer AS intake_id,
       'settlement_matches_wallet'::text AS detail_key,
       s.gross AS expected_cents, lc.amount_cents::bigint AS found_cents,
       (COALESCE(lc.amount_cents::bigint, 0) - s.gross) AS difference_cents,
       COALESCE((s.gross > 0 AND lc.amount_cents::bigint IS DISTINCT FROM s.gross) OR (s.gross = 0 AND lc.id IS NOT NULL)
             OR (s.fee > 0 AND lf.amount_cents::bigint IS DISTINCT FROM -s.fee) OR (s.fee = 0 AND lf.id IS NOT NULL), true) AS is_exception
FROM s
LEFT JOIN ${LEDGER} lc ON lc.reference_type = 'return_case_vendor_settlement' AND lc.reference_id = s.id::text || ':credit'
LEFT JOIN ${LEDGER} lf ON lf.reference_type = 'return_case_vendor_settlement' AND lf.reference_id = s.id::text || ':fee'
UNION ALL
SELECT 'rma_inspection', ins.id::text, ins.vendor_id, ins.intake_id, 'inspection_matches_wallet',
       ins.credit, lc.amount_cents::bigint, (COALESCE(lc.amount_cents::bigint, 0) - ins.credit),
       COALESCE((ins.credit > 0 AND lc.amount_cents::bigint IS DISTINCT FROM ins.credit) OR (ins.credit = 0 AND lc.id IS NOT NULL)
             OR (ins.fee > 0 AND lf.amount_cents::bigint IS DISTINCT FROM -ins.fee) OR (ins.fee = 0 AND lf.id IS NOT NULL), true)
FROM ins
LEFT JOIN ${LEDGER} lc ON lc.reference_type = 'dropship_rma' AND lc.reference_id = ins.rma_id::text || ':credit'
LEFT JOIN ${LEDGER} lf ON lf.reference_type = 'dropship_rma' AND lf.reference_id = ins.rma_id::text || ':fee'
UNION ALL
SELECT 'order', c.intake_id::text, c.vendor_id, c.intake_id, 'credited_once_within_billed',
       c.total_debit, (c.rma_credits + c.case_credits), (c.rma_credits + c.case_credits - c.total_debit),
       COALESCE((c.rma_credits > 0 AND c.case_credits > 0) OR c.rma_credits + c.case_credits > c.total_debit, true)
FROM credits c`;

/** R2: every no-inspection pool payout has the wallet credit it mirrors, for the same amount (recon 15). $1 vendor. */
const R2_SQL = `
SELECT 'pool_entry'::text AS item_kind, pl.id::text AS item_id, l.vendor_id, NULL::integer AS intake_id,
       'payout_mirrors_wallet_credit'::text AS detail_key,
       (-pl.amount_cents::bigint) AS expected_cents, l.amount_cents::bigint AS found_cents,
       (COALESCE(l.amount_cents::bigint, 0) + pl.amount_cents::bigint) AS difference_cents,
       COALESCE(l.id IS NULL OR l.type <> 'insurance_pool_credit' OR l.amount_cents::bigint <> -pl.amount_cents::bigint, true) AS is_exception
FROM dropship.dropship_insurance_pool_ledger pl
LEFT JOIN ${LEDGER} l ON l.id = pl.wallet_ledger_entry_id
WHERE pl.entry_type = 'no_inspection_payout' AND ${vendorFilter("l.vendor_id", "$1")}`;

/**
 * N1: no order we charged for was cancelled in OMS (recon 9). The difference
 * is what was charged for the cancelled orders (nothing has refunded it:
 * no refund path exists). $1 vendor.
 */
const N1_SQL = `
SELECT 'order'::text AS item_kind, e.intake_id::text AS item_id, e.vendor_id, e.intake_id,
       'charged_but_cancelled_in_oms'::text AS detail_key,
       0::bigint AS expected_cents, e.total_debit_cents::bigint AS found_cents, e.total_debit_cents::bigint AS difference_cents,
       COALESCE(oo.cancelled_at IS NOT NULL OR oo.status = 'cancelled', false) AS is_exception
FROM ${ECONOMICS} e
JOIN oms.oms_orders oo ON oo.id = e.oms_order_id
WHERE ${vendorFilter("e.vendor_id", "$1")}`;

/** N2 (program only): no intake that ended without a charge left its OMS order pending (recon 9, spot check 9). No parameters. */
const N2_SQL = `
SELECT 'intake'::text AS item_kind, i.id::text AS item_id, i.vendor_id, i.id AS intake_id,
       'leftover_oms_order'::text AS detail_key,
       NULL::bigint AS expected_cents, NULL::bigint AS found_cents, NULL::bigint AS difference_cents,
       COALESCE(oo.status = 'pending' AND oo.financial_status = 'pending'
                AND NOT EXISTS (SELECT 1 FROM ${ECONOMICS} e WHERE e.intake_id = i.id), true) AS is_exception
FROM dropship.dropship_order_intake i
JOIN oms.oms_orders oo ON oo.id = i.oms_order_id
WHERE i.status IN ('cancelled', 'rejected', 'failed', 'exception')`;

/**
 * N3: no wallet entry has a type nothing should write, an unexpected status,
 * a settled entry without a settle time, or a settle time that differs from
 * its post time outside deposits (recon 9). $1 vendor.
 */
const N3_SQL = `
SELECT 'ledger_entry'::text AS item_kind, l.id::text AS item_id, l.vendor_id, NULL::integer AS intake_id,
       CASE WHEN l.type IN ('refund_credit', 'manual_adjustment') THEN 'unexpected_type'
            WHEN l.status = 'voided' OR (l.type <> 'funding' AND l.status <> 'settled') THEN 'unexpected_status'
            WHEN l.status = 'settled' AND l.settled_at IS NULL THEN 'settled_without_time'
            WHEN l.status = 'settled' AND l.type <> 'funding' AND l.settled_at IS DISTINCT FROM l.created_at THEN 'settle_time_differs'
            ELSE 'expected' END AS detail_key,
       NULL::bigint AS expected_cents, NULL::bigint AS found_cents, NULL::bigint AS difference_cents,
       COALESCE(l.type IN ('refund_credit', 'manual_adjustment')
             OR l.status = 'voided' OR (l.type <> 'funding' AND l.status <> 'settled')
             OR (l.status = 'settled' AND l.settled_at IS NULL)
             OR (l.status = 'settled' AND l.type <> 'funding' AND l.settled_at IS DISTINCT FROM l.created_at), true) AS is_exception
FROM ${LEDGER} l
WHERE ${vendorFilter("l.vendor_id", "$1")}`;

const PERIOD_VENDOR: readonly FinanceSqlParam[] = ["startBound", "endBound", "vendorId"];
const VENDOR_ONLY: readonly FinanceSqlParam[] = ["vendorId"];

/**
 * Every SQL check, in run order. The all-time order scan (K3) is last so the
 * request budget skips it first (contract §4). P1 and P2 are worked out by
 * the builder.
 */
export const FINANCE_CHECK_SQL: readonly FinanceCheckSql[] = Object.freeze([
  { id: "W1", requires: ["accounts", "ledger"], programOnly: false, build: fixed(VENDOR_ONLY, W1_SQL) },
  { id: "W2", requires: ["accounts", "ledger"], programOnly: false, build: fixed(VENDOR_ONLY, W2_SQL) },
  { id: "W3", requires: ["accounts", "ledger", "lots"], programOnly: false, build: fixed(VENDOR_ONLY, W3_SQL) },
  { id: "W4", requires: ["accounts", "ledger"], programOnly: false, build: w4Sql },
  { id: "O1", requires: ["economics", "oms_orders", "ledger"], programOnly: false, build: fixed(ORDER_CTE_PARAMS, O1_SQL) },
  { id: "O2", requires: ["economics"], programOnly: false, build: fixed(ORDER_CTE_PARAMS, O2_SQL) },
  { id: "O3", requires: ["economics", "quotes"], programOnly: false, build: fixed(ORDER_CTE_PARAMS, O3_SQL) },
  { id: "O4", requires: ["economics", "oms_orders", "oms_lines"], programOnly: false, build: fixed(ORDER_CTE_PARAMS, O4_SQL) },
  { id: "O5", requires: ["economics", "intake", "oms_orders", "ledger"], programOnly: false, build: fixed(ORDER_CTE_PARAMS, O5_SQL) },
  { id: "O6", requires: [...ORDER_TABLES, "intake"], programOnly: false, build: o6Sql },
  { id: "D1", requires: ["ledger"], programOnly: false, build: d1Sql },
  { id: "D2", requires: ["ledger"], programOnly: false, build: fixed(PERIOD_VENDOR, D2_SQL) },
  { id: "D3", requires: ["ledger"], programOnly: false, build: fixed(PERIOD_VENDOR, D3_SQL) },
  { id: "D4", requires: ["ledger", "usdc"], programOnly: false, build: fixed(PERIOD_VENDOR, D4_SQL) },
  { id: "D5", requires: ["ledger", "collection_attempts"], programOnly: false, build: fixed(VENDOR_ONLY, D5_SQL) },
  { id: "D6", requires: ["ledger", "funding_methods"], programOnly: false, build: fixed(["vendorId", "now"], D6_SQL) },
  { id: "D7", requires: ["ledger"], programOnly: false, build: fixed([...PERIOD_VENDOR, "startIso", "endIso"], D7_SQL) },
  { id: "K1", requires: ORDER_TABLES, programOnly: false, build: k1Sql },
  { id: "K2", requires: ORDER_TABLES, programOnly: false, build: k2Sql },
  { id: "R1", requires: ["ledger", "economics", "settlements", "return_cases", "rmas", "inspections"], programOnly: false, build: fixed(PERIOD_VENDOR, R1_SQL) },
  { id: "R2", requires: ["ledger", "pool_ledger"], programOnly: false, build: fixed(VENDOR_ONLY, R2_SQL) },
  { id: "N1", requires: ["economics", "oms_orders"], programOnly: false, build: fixed(VENDOR_ONLY, N1_SQL) },
  { id: "N2", requires: ["intake", "oms_orders", "economics"], programOnly: true, build: fixed([], N2_SQL) },
  { id: "N3", requires: ["ledger"], programOnly: false, build: fixed(VENDOR_ONLY, N3_SQL) },
  { id: "K3", requires: ORDER_TABLES, programOnly: false, build: k3Sql },
] satisfies FinanceCheckSql[]);

/** The tables each section's statement cannot run without (contract §2.0 "core"). */
export const FINANCE_SECTION_REQUIRES = Object.freeze({
  orders: [...ORDER_TABLES, "intake"],
  products: ORDER_TABLES,
  neverCharged: ["intake", "economics"],
  ledger: ["ledger", "funding_methods"],
  disputes: ["ledger"],
  returnFees: ["ledger"],
  wallets: ["accounts"],
  pool: ["economics", "intake"],
  vendors: [...ORDER_TABLES, "vendors", "funding_methods", "accounts"],
  bridge: ["intake", "oms_orders", "economics"],
} satisfies Record<string, readonly FinanceTableKey[]>);
