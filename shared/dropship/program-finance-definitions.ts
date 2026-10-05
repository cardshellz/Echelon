import {
  FINANCE_CHECK_IDS,
  FINANCE_COST_WAIT_ALERT_DAYS,
  FINANCE_DATED_BY,
  FINANCE_INFO_KEYS,
  FINANCE_LINE_KEYS,
  FINANCE_METRIC_KEYS,
  FINANCE_NEVER_CHARGED_KINDS,
  FINANCE_NOTE_KEYS,
  FINANCE_SECTION_KEYS,
  FINANCE_STALE_PENDING_DEPOSIT_DAYS,
  FINANCE_WAITING_REASONS,
  type FinanceAnchorKey,
  type FinanceCheckGroup,
  type FinanceCheckId,
  type FinanceCheckResult,
  type FinanceCheckScope,
  type FinanceDatedBy,
  type FinanceInfoKey,
  type FinanceInfoLineKey,
  type FinanceLineKey,
  type FinanceLineStatus,
  type FinanceMetricKey,
  type FinanceNeverChargedKind,
  type FinanceNoteKey,
  type FinanceSectionKey,
  type FinanceSectionLineKey,
  type FinanceSectionStatus,
  type FinanceUnit,
  type FinanceWaitingReason,
} from "./program-finance";

/**
 * Every word the Program finance page shows for a number, and where that
 * number comes from: one registry for the "How this page counts" sheet, the
 * "How this is worked out" drawer, the CSV `definition` column and the
 * server's choice of units and links (spec §3.1, §10; contract §2).
 *
 * Each entry has:
 * - `words`: the copy deck's label (spec §10), verbatim where the deck gives
 *   one. `{placeholders}` are the deck's: `{$}` money, `{n}` `{x}` `{y}`
 *   counts, `{p}` a percent, `{period}` the period label, `{date}` a day.
 * - `definition`: one plain sentence, no jargon.
 * - `technicalSource`: tables, columns, filters and the date column, for the
 *   collapsed "Technical source". Every source is also limited to the vendor
 *   in view when one is chosen (FINANCE_VENDOR_SCOPE_NOTE).
 *
 * The keys are the closed lists in program-finance.ts; the records below
 * are typed by them, so a key without words does not compile.
 */

export interface FinanceTechnicalSource {
  /** Schema-qualified tables read. */
  readonly tables: readonly string[];
  /** Columns read, or the arithmetic over them. */
  readonly columns: readonly string[];
  /** Conditions a row must meet to count. */
  readonly filters: readonly string[];
  /** The column that places a row in the period; null for a balance right now or a figure with no date. */
  readonly dateColumn: string | null;
}

export interface FinanceDefinition {
  readonly words: string;
  readonly definition: string;
  readonly technicalSource: FinanceTechnicalSource;
}

export interface FinanceLineDefinition extends FinanceDefinition {
  /** What the line's integer means; the server sends this unit for this key. */
  readonly unit: FinanceUnit;
  /** The list sheet behind the line (part 2 of the page); absent when it opens nothing or only the How drawer. */
  readonly opensMetric?: FinanceMetricKey;
  /** The label when the period ended before now, for a line that is otherwise "now". */
  readonly wordsAtEndOfPeriod?: string;
}

export const FINANCE_VENDOR_SCOPE_NOTE =
  "In a vendor's view every source is limited to that vendor: economics, intake, wallet entries and wallets by vendor_id.";

// ── shared source fragments (constant text, contract §2.0) ───────────────

const ECONOMICS = "dropship.dropship_order_economics_snapshots";
const INTAKE = "dropship.dropship_order_intake";
const QUOTES = "dropship.dropship_shipping_quote_snapshots";
const LEDGER = "dropship.dropship_wallet_ledger";
const ACCOUNTS = "dropship.dropship_wallet_accounts";
const FUNDING_METHODS = "dropship.dropship_funding_methods";
const REWARDS_LOTS = "dropship.dropship_wallet_rewards_lots";
const POOL_LEDGER = "dropship.dropship_insurance_pool_ledger";
const CLAIMS = "dropship.dropship_carrier_claims";
const RMAS = "dropship.dropship_rmas";
const INSPECTIONS = "dropship.dropship_rma_inspections";
const USDC_ENTRIES = "dropship.dropship_usdc_ledger_entries";
const COLLECTION_ATTEMPTS = "dropship.dropship_collection_attempts";
const MAINTENANCE_RUNS = "dropship.dropship_wallet_maintenance_runs";
const AUDIT_EVENTS = "dropship.dropship_audit_events";
const ALLOCATIONS = "dropship.dropship_shipment_shipping_allocations";
const VENDORS = "dropship.dropship_vendors";
const OMS_ORDERS = "oms.oms_orders";
const OMS_LINES = "oms.oms_order_lines";
const ITEM_COSTS = "oms.order_item_costs";
const WMS_ORDERS = "wms.orders";
const WMS_ITEMS = "wms.order_items";
const SHIPMENTS = "wms.outbound_shipments";
const SHIPMENT_ITEMS = "wms.outbound_shipment_items";
const VARIANTS = "catalog.product_variants";
const PRODUCTS = "catalog.products";
const INVENTORY_LOTS = "inventory.inventory_lots";
const PICK_MOVEMENTS = "inventory.availability_claim_pick_movements";
const RETURN_CASES = "returns.return_cases";
const SETTLEMENTS = "returns.return_case_vendor_settlements";

const ACCEPTED_AT = `${ECONOMICS}.created_at`;
const POSTED_AT = `${LEDGER}.created_at`;
const SETTLED_AT = `${LEDGER}.settled_at`;
const RECEIVED_AT = `${INTAKE}.received_at`;

const ACCEPTED_IN_PERIOD = "economics.created_at within the period (the day we accepted the order, Eastern time)";
const FULLY_COSTED = "fully costed orders only: none of the seven waiting reasons applies (spec §3.0)";
const WMS_JOIN = "wms.orders.source = 'oms' AND wms.orders.oms_fulfillment_order_id = economics.oms_order_id::text";
const LINES_JOIN = "oms.oms_order_lines.order_id = economics.oms_order_id (never the intake's oms_order_id)";
const QUOTE_JOIN = "dropship_shipping_quote_snapshots.id = economics.shipping_quote_snapshot_id";
const PACKAGE_STATUSES = "wms.outbound_shipments.status IN ('shipped', 'returned', 'lost'); voided labels count as $0";
const LABEL_ONCE =
  "each label counted once: by ShipStation shipment id for shipstation_shipment:<id> and shipstation_combined:<id> rows, else by package id";
const COGS_MILLS =
  "Σ COALESCE(NULLIF(oms.order_item_costs.total_cost_mills, 0), total_cost_cents::bigint × 100) mills, rounded to cents once, half away from zero";
const SETTLED = "status = 'settled'";
const POSTED_IN_PERIOD = "created_at within the period";
const SETTLED_IN_PERIOD = "settled_at within the period";
const RAIL = "way paid = COALESCE(metadata->>'rail', dropship_funding_methods.rail, 'unknown')";
const NOT_COLLECTION = "metadata->>'collection' is not 'true'";
const AVAILABLE_TYPES =
  "type moves the wallet balance: funding, order_debit, advance_fee, funding_reversal, funding_reinstated, return_credit, insurance_pool_credit, return_fee, refund_credit, manual_adjustment";
const REWARDS_TYPES = "type IN ('rewards_earned', 'rewards_spent', 'rewards_expired', 'rewards_reversed', 'rewards_reinstated')";
const WHOLE_CENTS = "metadata amounts count only when they are whole cents (^-?[0-9]{1,18}$); others are left out and listed by check D7";
const ORDER_PAYMENT_JOIN = "dropship_wallet_ledger.reference_id = economics.intake_id::text";
const ORDER_TABLES = [ECONOMICS, OMS_ORDERS, OMS_LINES, WMS_ORDERS, WMS_ITEMS, ITEM_COSTS, SHIPMENTS, SHIPMENT_ITEMS];

function source(
  tables: readonly string[],
  columns: readonly string[],
  filters: readonly string[],
  dateColumn: string | null,
): FinanceTechnicalSource {
  return Object.freeze({
    tables: Object.freeze([...tables]),
    columns: Object.freeze([...columns]),
    filters: Object.freeze([...filters]),
    dateColumn,
  });
}

/** Orders accepted in the period, all of them. */
function ordersSource(columns: readonly string[], tables: readonly string[] = [], filters: readonly string[] = []) {
  return source([ECONOMICS, ...tables], columns, [ACCEPTED_IN_PERIOD, ...filters], ACCEPTED_AT);
}

/** Orders accepted in the period that are fully costed. */
function fullyCostedSource(columns: readonly string[], filters: readonly string[] = []) {
  return source(ORDER_TABLES, columns, [ACCEPTED_IN_PERIOD, FULLY_COSTED, WMS_JOIN, ...filters], ACCEPTED_AT);
}

/** Settled wallet entries of some type, posted in the period. */
function postedSource(columns: readonly string[], filters: readonly string[], tables: readonly string[] = []) {
  return source([LEDGER, ...tables], columns, [SETTLED, POSTED_IN_PERIOD, ...filters], POSTED_AT);
}

/** Settled deposits, by the day they settled. */
function depositSource(columns: readonly string[], filters: readonly string[]) {
  return source([LEDGER, FUNDING_METHODS], columns, ["type = 'funding'", SETTLED, SETTLED_IN_PERIOD, ...filters], SETTLED_AT);
}

/** Something Echelon does not record: no table holds it. */
function notRecordedSource(what: string): FinanceTechnicalSource {
  return source([], [`none: ${what}`], [], null);
}

function line(
  unit: FinanceUnit,
  words: string,
  definition: string,
  technicalSource: FinanceTechnicalSource,
  options: { opensMetric?: FinanceMetricKey; wordsAtEndOfPeriod?: string } = {},
): FinanceLineDefinition {
  return Object.freeze({ unit, words, definition, technicalSource, ...options });
}

// ── waiting reasons (spec §3.0, §10) ─────────────────────────────────────

export interface FinanceWaitingReasonDefinition extends FinanceDefinition {
  /** The label on a summary line, where one order's pack counts don't apply. */
  readonly summaryWords: string;
}

export const FINANCE_WAITING_REASON_DEFINITIONS: Readonly<Record<FinanceWaitingReason, FinanceWaitingReasonDefinition>> =
  Object.freeze({
    cancelled_in_oms: {
      words: "Cancelled in OMS after the vendor was charged",
      summaryWords: "Cancelled in OMS after the vendor was charged",
      definition: "The order was cancelled in OMS after we charged the vendor; there is no refund step, so the vendor stays charged.",
      technicalSource: source([OMS_ORDERS], ["oms.oms_orders.cancelled_at", "oms.oms_orders.status"], [
        "oms.oms_orders.id = economics.oms_order_id",
        "cancelled_at IS NOT NULL OR status = 'cancelled'",
      ], ACCEPTED_AT),
    },
    not_shipped: {
      words: "Not shipped yet",
      summaryWords: "Not shipped yet",
      definition: "No pack of the order has shipped to the customer yet.",
      technicalSource: source([WMS_ORDERS, SHIPMENTS, SHIPMENT_ITEMS], ["Σ wms.outbound_shipment_items.qty = 0"], [
        WMS_JOIN,
        PACKAGE_STATUSES,
        "shipment_item_purpose = 'customer_fulfillment'",
      ], ACCEPTED_AT),
    },
    partly_shipped: {
      words: "Partly shipped ({x} of {y} packs)",
      summaryWords: "Partly shipped",
      definition: "Some packs of the order have shipped and some have not.",
      technicalSource: source([WMS_ORDERS, SHIPMENTS, SHIPMENT_ITEMS, OMS_LINES], [
        "Σ wms.outbound_shipment_items.qty < Σ oms.oms_order_lines.quantity",
      ], [WMS_JOIN, PACKAGE_STATUSES, "shipment_item_purpose = 'customer_fulfillment'", LINES_JOIN], ACCEPTED_AT),
    },
    over_shipped: {
      words: "Shipped more packs than ordered",
      summaryWords: "Shipped more packs than ordered",
      definition: "More packs shipped to the customer than the order accepted (check O6 lists it).",
      technicalSource: source([WMS_ORDERS, SHIPMENTS, SHIPMENT_ITEMS, OMS_LINES], [
        "Σ wms.outbound_shipment_items.qty > Σ oms.oms_order_lines.quantity",
      ], [WMS_JOIN, PACKAGE_STATUSES, "shipment_item_purpose = 'customer_fulfillment'", LINES_JOIN], ACCEPTED_AT),
    },
    shared_label: {
      words: "Shares one label with another order",
      summaryWords: "Shares one label with another order",
      definition: "One of the order's packages went on a label that also covers another order; a shared label is never split.",
      technicalSource: source([WMS_ORDERS, SHIPMENTS], ["wms.outbound_shipments.external_fulfillment_id"], [
        WMS_JOIN,
        PACKAGE_STATUSES,
        "a shipstation_combined:<id> row, or a ShipStation shipment id that more than one OMS order's packages carry",
      ], ACCEPTED_AT),
    },
    label_missing: {
      words: "Label cost not recorded",
      summaryWords: "Label cost not recorded",
      definition: "At least one of the order's labels has no cost recorded yet.",
      technicalSource: source([WMS_ORDERS, SHIPMENTS], ["wms.outbound_shipments.carrier_cost_source IS NULL"], [
        WMS_JOIN,
        PACKAGE_STATUSES,
      ], ACCEPTED_AT),
    },
    item_cost_missing: {
      words: "Cost of goods not recorded for {n} packs",
      summaryWords: "Cost of goods not recorded",
      definition: "The packs with a recorded cost of goods don't match the packs on the order yet.",
      technicalSource: source([OMS_LINES, WMS_ORDERS, WMS_ITEMS, ITEM_COSTS], [
        "per OMS line: net Σ oms.order_item_costs.qty ≠ oms.oms_order_lines.quantity",
      ], [WMS_JOIN, "wms.order_items.oms_order_line_id = oms.oms_order_lines.id", "unpick rows are negative and net out"], ACCEPTED_AT),
    },
  });

// ── intakes that never moved money (contract §2.3) ───────────────────────

const NEVER_CHARGED_DEFINITIONS: Readonly<Record<FinanceNeverChargedKind, { words: string; definition: string; test: string }>> = {
  waiting_for_payment: {
    words: "waiting for payment",
    definition: "Held until the vendor's wallet can pay for it.",
    test: "status = 'payment_hold'",
  },
  payment_time_ran_out: {
    words: "payment time ran out",
    definition: "Held for payment until the time to pay ran out.",
    test: "cancellation_status = 'payment_hold_expired'",
  },
  rejected: {
    words: "rejected",
    definition: "Rejected when it arrived.",
    test: "cancellation_status = 'order_intake_rejected' OR status = 'rejected'",
  },
  marketplace_cancelled: {
    words: "cancelled on the marketplace",
    definition: "Cancelled on the marketplace before we charged for it.",
    test: "cancellation_status = 'marketplace_cancelled'",
  },
  failed: {
    words: "failed",
    definition: "Processing failed before we charged for it.",
    test: "status = 'failed'",
  },
  exception: {
    words: "marked as an exception",
    definition: "Marked as an exception before we charged for it.",
    test: "status = 'exception'",
  },
};

// ── line definitions ─────────────────────────────────────────────────────

const WAITING_REASON_LINES = Object.fromEntries(
  FINANCE_WAITING_REASONS.map((reason) => {
    const reasonDefinition = FINANCE_WAITING_REASON_DEFINITIONS[reason];
    return [
      `sales.waiting.${reason}`,
      line(
        "cents",
        reasonDefinition.summaryWords,
        `What we billed on orders still waiting because: ${reasonDefinition.definition.charAt(0).toLowerCase()}${reasonDefinition.definition.slice(1)}`,
        source(
          [ECONOMICS, ...reasonDefinition.technicalSource.tables],
          ["Σ economics.total_debit_cents", ...reasonDefinition.technicalSource.columns],
          [ACCEPTED_IN_PERIOD, ...reasonDefinition.technicalSource.filters, "the first waiting reason that applies, in the spec §3.0 order"],
          ACCEPTED_AT,
        ),
        { opensMetric: "sales.waiting" },
      ),
    ];
  }),
) as Record<`sales.waiting.${FinanceWaitingReason}`, FinanceLineDefinition>;

const NEVER_CHARGED_LINES = Object.fromEntries(
  FINANCE_NEVER_CHARGED_KINDS.map((kind) => {
    const kindDefinition = NEVER_CHARGED_DEFINITIONS[kind];
    return [
      `sales.never_charged.${kind}`,
      line(
        "count",
        kindDefinition.words,
        `Orders received in the period and never charged: ${kindDefinition.definition.charAt(0).toLowerCase()}${kindDefinition.definition.slice(1)}`,
        source([INTAKE, ECONOMICS], ["COUNT(*)"], [
          "received_at within the period",
          kindDefinition.test,
          "no economics row for the intake",
        ], RECEIVED_AT),
        { opensMetric: "sales.no_money" },
      ),
    ];
  }),
) as Record<`sales.never_charged.${FinanceNeverChargedKind}`, FinanceLineDefinition>;

const POOL_KIND_WORDS = {
  no_inspection: { words: "lost or approved without inspection", referenceType: "dropship_rma_no_inspection" },
  inspection_fault: { words: "carrier fault found on inspection", referenceType: "dropship_rma" },
  return_case_fault: { words: "carrier fault on a return case", referenceType: "return_case_vendor_settlement" },
} as const;

function poolCreditKind(kind: keyof typeof POOL_KIND_WORDS, opensMetric: FinanceMetricKey): FinanceLineDefinition {
  const { words, referenceType } = POOL_KIND_WORDS[kind];
  return line(
    "cents",
    words,
    `Return credits paid from the insurance pool for ${words}.`,
    postedSource(["Σ amount_cents"], ["type = 'insurance_pool_credit'", `reference_type = '${referenceType}'`]),
    { opensMetric },
  );
}

function pointsMovement(type: string, words: string, definition: string, sign: "Σ" | "−Σ"): FinanceLineDefinition {
  return line("points", words, definition, postedSource([`${sign} amount_cents (1 point = 1¢)`], [`type = '${type}'`]), {
    opensMetric: "points.movements",
  });
}

function expiryBucket(words: string, definition: string, expiresAtFilter: string): FinanceLineDefinition {
  return line("points", words, definition, source([REWARDS_LOTS], ["Σ remaining_cents"], ["remaining_cents > 0", expiresAtFilter], null), {
    opensMetric: "points.expiry",
  });
}

function walkMovement(words: string, definition: string, typeFilter: string): FinanceLineDefinition {
  return line(
    "cents",
    words,
    definition,
    source([LEDGER, FUNDING_METHODS], ["Σ amount_cents (signed)"], [SETTLED, "moved within the period: deposits by settled_at, other entries by created_at", typeFilter], SETTLED_AT),
    { opensMetric: "owed.walk" },
  );
}

const SALES_LINES = {
  "sales.billed": line("cents", "Billed to vendors",
    "What we charged vendors for the orders we accepted in the period: product plus shipping, with the insurance pool share inside shipping.",
    ordersSource(["Σ total_debit_cents"]), { opensMetric: "sales.billed" }),
  "sales.billed.product": line("cents", "product", "What we billed for the products on those orders.",
    ordersSource(["Σ wholesale_subtotal_cents"]), { opensMetric: "sales.billed" }),
  "sales.billed.shipping": line("cents", "shipping", "What we billed for shipping on those orders, insurance pool share included.",
    ordersSource(["Σ shipping_cents"]), { opensMetric: "sales.billed" }),
  "sales.billed.carrier_estimate": line("cents", "carrier estimate", "The carrier rate we quoted when each order was accepted.",
    ordersSource(["Σ dropship_shipping_quote_snapshots.base_rate_cents"], [QUOTES], [QUOTE_JOIN, "an order with no saved quote makes the line partial"]),
    { opensMetric: "sales.billed" }),
  "sales.billed.markup": line("cents", "our markup", "Our markup on top of the carrier estimate. It is counted here only, never as a fee.",
    ordersSource(["Σ dropship_shipping_quote_snapshots.markup_cents"], [QUOTES], [QUOTE_JOIN, "an order with no saved quote makes the line partial"]),
    { opensMetric: "sales.billed" }),
  "sales.billed.pool_share": line("cents", "insurance pool share", "The part of shipping set aside for the insurance pool, on every order accepted.",
    ordersSource(["Σ insurance_pool_cents"]), { opensMetric: "sales.billed" }),
  "sales.billed.paid_from_wallets": line("cents", "paid from wallets", "The part of what we billed that came out of vendors' wallet balances.",
    ordersSource(["−Σ dropship_wallet_ledger.amount_cents"], [LEDGER], ["type = 'order_debit'", "reference_type = 'order_intake'", ORDER_PAYMENT_JOIN]),
    { opensMetric: "sales.paid_points" }),
  "sales.billed.paid_with_points": line("cents", "paid with points",
    "The part of what we billed that vendors paid with points (1 point = 1¢); no cash came in for it.",
    ordersSource(["−Σ dropship_wallet_ledger.amount_cents"], [LEDGER], ["type = 'rewards_spent'", "reference_type = 'order_intake_rewards'", ORDER_PAYMENT_JOIN]),
    { opensMetric: "sales.paid_points" }),
  "sales.waiting": line("cents", "Not yet fully costed",
    "What we billed on orders whose costs are not all recorded yet. They count once their costs are recorded.",
    source(ORDER_TABLES, ["Σ economics.total_debit_cents"], [ACCEPTED_IN_PERIOD, "orders with a waiting reason (spec §3.0)", WMS_JOIN], ACCEPTED_AT),
    { opensMetric: "sales.waiting" }),
  ...WAITING_REASON_LINES,
  "sales.billed_fc": line("cents", "Billed on fully costed orders",
    "What we billed on the orders whose every pack has shipped, every label has its cost and every item has its cost recorded.",
    fullyCostedSource(["Σ economics.total_debit_cents"]), { opensMetric: "sales.billed" }),
  "sales.cogs": line("cents", "Cost of goods (what the products cost us)",
    "Today's cost of the stock each fully costed order used (oldest stock first), rounded to the cent once for the total.",
    fullyCostedSource([COGS_MILLS], ["oms.order_item_costs.order_item_id = wms.order_items.id"]), { opensMetric: "sales.cogs" }),
  "sales.labels": line("cents", "Carrier labels", "What the carrier labels for fully costed orders cost us, each label counted once.",
    fullyCostedSource(["Σ wms.outbound_shipments.carrier_cost_cents::bigint"], [PACKAGE_STATUSES, "carrier_cost_source IS NOT NULL", LABEL_ONCE]),
    { opensMetric: "sales.labels" }),
  "sales.labels.replacement": line("cents", "of which replacement packages", "Labels on replacement packages, already inside carrier labels.",
    fullyCostedSource(["Σ wms.outbound_shipments.carrier_cost_cents::bigint"], [PACKAGE_STATUSES, "carrier_cost_source IS NOT NULL", "shipment_purpose = 'replacement'", LABEL_ONCE]),
    { opensMetric: "sales.labels" }),
  "sales.pool_fc": line("cents", "Insurance pool share (set aside, not ours to keep)",
    "The insurance pool share on fully costed orders. It is a reserve for lost parcels, not profit.",
    fullyCostedSource(["Σ economics.insurance_pool_cents"]), { opensMetric: "sales.pool_fc" }),
  "sales.packaging": line("cents", "Packaging", "Box and mailer costs. Echelon doesn't save them per package, so nothing is taken off.",
    notRecordedSource("no writer saves a packaging cost per package; dropship_shipping_quote_snapshots.dunnage_cents is always 0 (check O3)")),
  "sales.kept_orders": line("cents", "Kept on orders",
    "What we billed on fully costed orders minus their cost of goods, carrier labels and insurance pool share.",
    fullyCostedSource(["billed on fully costed orders − cost of goods − carrier labels − insurance pool share"]),
    { opensMetric: "sales.kept_orders" }),
  "sales.kept_orders.on_products": line("cents", "on products",
    "Product billed on fully costed orders minus their cost of goods. The percent is of that product billed.",
    fullyCostedSource(["Σ economics.wholesale_subtotal_cents − cost of goods"])),
  "sales.kept_orders.on_shipping": line("cents", "on shipping",
    "Shipping billed on fully costed orders, less the pool share, minus their carrier labels. The percent is of that shipping.",
    fullyCostedSource(["Σ (economics.shipping_cents − economics.insurance_pool_cents) − carrier labels"])),
  "sales.fees": line("cents", "Fees we charged", "Advance fees, card fees and return fees vendors paid us, each on the day it was posted.",
    source([LEDGER], ["advance fees + card fees + return fees"], [SETTLED, "advance and return fees by created_at, card fees by settled_at, within the period"], POSTED_AT),
    { opensMetric: "sales.fees" }),
  "sales.fees.advance": line("cents", "advance fees",
    "Fees for letting an order through before the vendor's bank transfer cleared.",
    postedSource(["−Σ amount_cents"], ["type = 'advance_fee'"]), { opensMetric: "sales.fees" }),
  "sales.fees.card": line("cents", "card fees", "The card fee added to card top-ups, on the day the top-up settled.",
    depositSource(["Σ int(metadata->>'cardFeeCents')"], [WHOLE_CENTS]), { opensMetric: "sales.fees" }),
  "sales.fees.returns": line("cents", "return fees", "Return fees charged to vendors.",
    postedSource(["−Σ amount_cents"], ["type = 'return_fee'"]), { opensMetric: "sales.fees" }),
  "sales.return_credits_cs": line("cents", "Return credits we paid (not from the pool)",
    "Return credits Card Shellz paid vendors itself. Credits the insurance pool paid are not taken off.",
    postedSource(["Σ amount_cents"], ["type = 'return_credit'"]), { opensMetric: "returns.credits_cs" }),
  "sales.kept": line("cents", "What we kept",
    "Kept on orders, plus fees we charged, minus return credits we paid. Packaging, Stripe's fees and overheads are not taken off because Echelon does not record them.",
    source([...ORDER_TABLES, LEDGER], ["kept on orders + fees we charged − return credits we paid"], [
      "orders by the day accepted; fees and credits by the day posted",
    ], `${ACCEPTED_AT} (orders); ${POSTED_AT} and ${SETTLED_AT} (fees and credits)`)),
  "sales.memo.points_used": line("cents", "paid with points",
    "Points vendors used to pay for these orders. They count at full value in what we billed and are not taken off what we kept.",
    ordersSource(["−Σ dropship_wallet_ledger.amount_cents"], [LEDGER], ["type = 'rewards_spent'", "reference_type = 'order_intake_rewards'", ORDER_PAYMENT_JOIN]),
    { opensMetric: "sales.paid_points" }),
  "sales.memo.staff_credits": line("cents", "staff wallet credits",
    "Credits staff added to wallets by hand: corrections, not cash, and not taken off what we kept.",
    depositSource(["Σ amount_cents"], [`${RAIL} = 'manual'`]), { opensMetric: "returns.staff_credits" }),
  "sales.memo.pool_credits": line("cents", "pool-paid credits (the pool covers them)",
    "Return credits paid from the insurance pool. The pool covers them, so they are not taken off what we kept.",
    postedSource(["Σ amount_cents"], ["type = 'insurance_pool_credit'"]), { opensMetric: "returns.credits_pool" }),
  "sales.memo.stripe_fees": line("cents", "Stripe fees", "Stripe's processing and dispute fees. Echelon doesn't save them.",
    notRecordedSource("Stripe balance transactions are not ingested")),
  "sales.memo.overheads": line("cents", "overheads (not on this page)",
    "The costs of running Card Shellz that no order carries. This page does not cover them.",
    notRecordedSource("overheads are outside the dropship records")),
  "sales.buyer_paid": line("cents", "For context, not our money: buyers paid {$} on eBay and Shopify ({n} unknown)",
    "What buyers paid the vendors on eBay and Shopify for these orders. This is the vendors' sale, not Card Shellz money.",
    ordersSource(["Σ int(dropship_order_intake.normalized_payload->'totals'->>'grandTotalCents')"], [INTAKE], [
      "dropship_order_intake.id = economics.intake_id",
      "a missing or malformed total counts as unknown",
      "economics.retail_subtotal_cents is never read",
    ]), { opensMetric: "sales.buyer_paid" }),
  "sales.never_charged": line("count", "Received {period} and never charged: {n} orders",
    "Orders that reached Echelon in the period and never moved any money.",
    source([INTAKE, ECONOMICS], ["COUNT(*)"], ["received_at within the period", "one of the six never-charged kinds", "no economics row for the intake"], RECEIVED_AT),
    { opensMetric: "sales.no_money" }),
  ...NEVER_CHARGED_LINES,
  "sales.never_charged.would_have_charged": line("cents", "would have charged",
    "What we would have charged for the orders held for payment, from the latest payment-hold record of each.",
    source([INTAKE, AUDIT_EVENTS], ["Σ int(dropship_audit_events.payload->>'totalDebitCents')"], [
      "received_at within the period",
      "kinds waiting for payment and payment time ran out",
      "the latest 'order_acceptance_payment_hold' event of the intake",
    ], RECEIVED_AT), { opensMetric: "sales.no_money" }),
  "sales.label_coverage": line("count", "Label cost recorded on {x} of {y} packages shipped for orders accepted {period}",
    "How many labels on the orders accepted in the period have their cost recorded, each label counted once.",
    source([ECONOMICS, WMS_ORDERS, SHIPMENTS], ["COUNT(DISTINCT label) with carrier_cost_source IS NOT NULL", "of COUNT(DISTINCT label)"], [
      ACCEPTED_IN_PERIOD, WMS_JOIN, PACKAGE_STATUSES, LABEL_ONCE,
    ], ACCEPTED_AT), { opensMetric: "sales.label_coverage" }),
} satisfies Record<FinanceSectionLineKey<"sales">, FinanceLineDefinition>;

const PRODUCT_LINE_TABLES = [OMS_LINES, VARIANTS, PRODUCTS];

const PRODUCT_LINES = {
  "products.billed": line("cents", "Billed for product", "What we billed for products on the orders accepted in the period, line by line.",
    ordersSource(["Σ oms.oms_order_lines.total_price_cents::bigint"], [OMS_LINES], [LINES_JOIN]), { opensMetric: "products.all" }),
  "products.packs": line("count", "Packs", "Packs ordered on the orders accepted in the period.",
    ordersSource(["Σ oms.oms_order_lines.quantity"], [OMS_LINES], [LINES_JOIN]), { opensMetric: "products.all" }),
  "products.pieces": line("count", "Pieces",
    "Packs times the pieces in each pack. Lines with no catalog size are left out and counted.",
    ordersSource(["Σ oms.oms_order_lines.quantity × catalog.product_variants.units_per_variant"], PRODUCT_LINE_TABLES, [
      LINES_JOIN, "catalog.product_variants.id = oms.oms_order_lines.product_variant_id",
    ]), { opensMetric: "products.all" }),
  "products.lines_without_pieces": line("count", "pieces not recorded on {n} lines",
    "Order lines with no catalog size, so the pieces in each pack are unknown.",
    ordersSource(["COUNT(*) of lines with no catalog.product_variants row"], PRODUCT_LINE_TABLES, [LINES_JOIN]), { opensMetric: "products.all" }),
  "products.count": line("count", "products",
    "How many products and sizes sold: one per catalog size, plus one per SKU not linked to a catalog item.",
    ordersSource(["COUNT(DISTINCT 'v:' || product_variant_id, else 'sku:' || sku)"], PRODUCT_LINE_TABLES, [LINES_JOIN]),
    { opensMetric: "products.all" }),
  "products.packs_fully_costed": line("count", "Cost and kept cover packs on fully costed orders ({x} of {y} packs)",
    "Packs on fully costed orders, of all packs ordered. Cost of goods and kept cover only these.",
    fullyCostedSource(["Σ oms.oms_order_lines.quantity", "of Σ over all orders accepted"], [LINES_JOIN]), { opensMetric: "products.all" }),
  "products.packs_shipped": line("count", "{x} of {y} packs shipped",
    "Packs shipped to customers on these orders' shipped, returned or lost packages, of all packs ordered.",
    ordersSource(["Σ wms.outbound_shipment_items.qty", "of Σ oms.oms_order_lines.quantity"], [WMS_ORDERS, WMS_ITEMS, SHIPMENTS, SHIPMENT_ITEMS, OMS_LINES], [
      WMS_JOIN, PACKAGE_STATUSES, "shipment_item_purpose = 'customer_fulfillment'",
    ]), { opensMetric: "products.all" }),
  "products.cogs_unlinked": line("cents", "Cost not linked to an order line",
    "Cost of goods on fully costed orders that is recorded against no order line. It is shown on its own so the column adds up to the Sales cost of goods.",
    fullyCostedSource([COGS_MILLS], ["wms.order_items.oms_order_line_id IS NULL or not a line of the order"]), { opensMetric: "sales.cogs" }),
} satisfies Record<FinanceSectionLineKey<"products">, FinanceLineDefinition>;

const CHARGED = `Σ COALESCE(int(metadata->>'chargedCents'), amount_cents)`;

const CASH_LINES = {
  "cash.ach": line("cents", "Bank transfer (ACH)", "Bank transfers that settled in the period, at the amount charged.",
    depositSource([CHARGED], [`${RAIL} = 'stripe_ach'`, NOT_COLLECTION, WHOLE_CENTS]), { opensMetric: "cash.deposits" }),
  "cash.card": line("cents", "Card", "Card top-ups that settled in the period, at the amount charged, card fee included.",
    depositSource([CHARGED], [`${RAIL} = 'stripe_card'`, NOT_COLLECTION, WHOLE_CENTS]), { opensMetric: "cash.deposits" }),
  "cash.card.fees": line("cents", "includes {$} card fees charged to vendors",
    "The card fees inside the card amount. They are also counted in fees we charged.",
    depositSource(["Σ int(metadata->>'cardFeeCents')"], [`${RAIL} = 'stripe_card'`, WHOLE_CENTS]), { opensMetric: "cash.deposits" }),
  "cash.usdc": line("cents", "USDC (digital dollars)", "USDC deposits counted when they settled on chain in the period, at $1.00 per USDC.",
    depositSource([CHARGED], [`${RAIL} = 'usdc_base'`, NOT_COLLECTION]), { opensMetric: "cash.deposits" }),
  "cash.usdc.chain_watcher": line("cents", "found on chain automatically", "USDC deposits Echelon found on chain by itself.",
    depositSource([CHARGED], [`${RAIL} = 'usdc_base'`, "metadata->>'source' = 'chain_watcher'"]), { opensMetric: "cash.deposits" }),
  "cash.usdc.staff_confirmed": line("cents", "confirmed by staff", "USDC deposits staff confirmed by hand.",
    depositSource([CHARGED], [`${RAIL} = 'usdc_base'`, "metadata->>'source' is not 'chain_watcher'"]), { opensMetric: "cash.deposits" }),
  "cash.collection": line("cents", "Weekly collection (retired)", "Deposits the retired weekly collection took from vendors.",
    depositSource([CHARGED], ["metadata->>'collection' = 'true'"]), { opensMetric: "cash.deposits" }),
  "cash.unknown": line("cents", "Way paid not recorded", "Deposits with no way paid on the entry or on its funding method.",
    depositSource([CHARGED], [`${RAIL} = 'unknown'`, NOT_COLLECTION]), { opensMetric: "cash.deposits" }),
  "cash.received_deposits": line("cents", "Deposits received", "Every deposit that settled in the period, except staff wallet credits.",
    depositSource([CHARGED], [`${RAIL} ≠ 'manual'`, WHOLE_CENTS]), { opensMetric: "cash.deposits" }),
  "cash.pulled_back": line("cents", "Pulled back by disputes and bank returns",
    "Deposit money taken back by card disputes and bank returns posted in the period, at the disputed amount.",
    postedSource(["Σ int(metadata->>'disputeAmountCents')"], ["type = 'funding_reversal'", "a row with no disputed amount makes the line partial (check D7)"]),
    { opensMetric: "cash.disputes" }),
  "cash.won_back": line("cents", "Returned to us after disputes we won",
    "For each dispute won in the period, the disputed amount of the pull-back it reverses (owner decision 13).",
    postedSource(["Σ int(reversal.metadata->>'disputeAmountCents')"], [
      "type = 'funding_reinstated'",
      "paired with its funding_reversal by metadata->>'reversalLedgerEntryId', else by the same dispute id",
      "not Σ funding_reinstated.amount_cents: that is wallet money, not cash",
    ]), { opensMetric: "cash.disputes" }),
  "cash.received": line("cents", "Cash received · before Stripe's fees",
    "Deposits received, minus what disputes pulled back, plus what disputes we won returned. Stripe's own fees are not taken off.",
    source([LEDGER, FUNDING_METHODS], ["deposits received − pulled back + returned after disputes we won"], [SETTLED], SETTLED_AT)),
  "cash.memo.auto_top_ups": line("cents", "Of which automatic top-ups",
    "Deposits Echelon started by itself, to keep a vendor's minimum balance or to release a held order.",
    depositSource([CHARGED], ["metadata->>'autoReload' = 'true'"]), { opensMetric: "cash.deposits" }),
  "cash.memo.auto_top_ups.minimum_balance": line("cents", "to keep the minimum balance",
    "Automatic top-ups that kept a vendor's wallet at its minimum.",
    depositSource([CHARGED], ["metadata->>'autoReload' = 'true'", "metadata->>'autoReloadReason' = 'minimum_balance'"]), { opensMetric: "cash.deposits" }),
  "cash.memo.auto_top_ups.payment_hold": line("cents", "to release a held order",
    "Automatic top-ups that paid for an order held for payment.",
    depositSource([CHARGED], ["metadata->>'autoReload' = 'true'", "metadata->>'autoReloadReason' = 'payment_hold'"]), { opensMetric: "cash.deposits" }),
  "cash.memo.on_the_way": line("cents", "On the way right now",
    "Deposits vendors sent that haven't settled. It isn't cash yet and vendors can't spend it yet.",
    source([ACCOUNTS, LEDGER], ["Σ dropship_wallet_accounts.pending_balance_cents", "COUNT of funding entries with status = 'pending'"], [], null),
    { opensMetric: "cash.on_the_way" }),
  "cash.memo.stuck": line("cents", `Waiting more than ${FINANCE_STALE_PENDING_DEPOSIT_DAYS} days`,
    `Deposits still on the way more than ${FINANCE_STALE_PENDING_DEPOSIT_DAYS} days after they were sent.`,
    source([LEDGER], ["Σ amount_cents", "COUNT(*)"], ["type = 'funding'", "status = 'pending'", `created_at before now − ${FINANCE_STALE_PENDING_DEPOSIT_DAYS} days`], POSTED_AT),
    { opensMetric: "cash.stuck" }),
  "cash.memo.failed": line("cents", "Failed {period}: never counted as cash",
    "Deposits that failed in the period. None of it was counted as cash.",
    source([LEDGER], ["Σ amount_cents", "COUNT(*)", "metadata->'failure'->>'code' of the first"], [
      "type = 'funding'", "status = 'failed'", "metadata->'failure'->>'failedAt' within the period (ISO text; other text is listed by check D7)",
    ], `${LEDGER}.metadata->'failure'->>'failedAt'`), { opensMetric: "cash.failed" }),
  "cash.memo.not_won_back": line("cents", "Disputes not won back (still open or lost)",
    "Pull-backs posted in the period with no win recorded. Echelon can't tell a dispute that's still open from one we lost.",
    postedSource(["Σ int(metadata->>'disputeAmountCents')", "COUNT(*)"], [
      "type = 'funding_reversal'",
      "no 'stripe_dispute_reinstated' entry with the same reference_id",
    ]), { opensMetric: "cash.disputes" }),
  "cash.memo.staff_credits": line("cents", "Staff wallet credits aren't cash: see Returns and credits",
    "Credits staff added to wallets by hand in the period. They are not counted as cash.",
    depositSource(["Σ amount_cents", "COUNT(*)"], [`${RAIL} = 'manual'`, "reference_type = 'admin_manual_wallet_credit'"]),
    { opensMetric: "returns.staff_credits" }),
  "cash.memo.stripe_fees": line("cents", "Stripe's fees", "Stripe's processing and dispute fees. Echelon doesn't save them.",
    notRecordedSource("Stripe balance transactions are not ingested")),
  "cash.memo.usdc_moved_out": line("cents", "USDC moved out of deposit addresses",
    "Moves of USDC out of deposit addresses aren't recorded.",
    notRecordedSource("no record of sweeps or conversions from USDC deposit addresses")),
} satisfies Record<FinanceSectionLineKey<"cash">, FinanceLineDefinition>;

const FEE_PARTS_SOURCE = (settlementColumn: string, breakdownKey: string) =>
  source([LEDGER, SETTLEMENTS, INSPECTIONS], [
    `Σ COALESCE(returns.return_case_vendor_settlements.${settlementColumn}, int(dropship_rma_inspections.fee_breakdown->'fees'->'${breakdownKey}'->>'chargedCents'))`,
  ], [SETTLED, POSTED_IN_PERIOD, "type = 'return_fee'", "settlement by reference_id '<settlementId>:fee', inspection by reference_id '<rmaId>:fee'"], POSTED_AT);

const RETURN_LINES = {
  "returns.credited": line("cents", "Credited to vendors",
    "Return credits from Card Shellz and from the insurance pool posted in the period, before return fees.",
    postedSource(["Σ amount_cents"], ["type IN ('return_credit', 'insurance_pool_credit')"])),
  "returns.credits_cs": line("cents", "Credited by Card Shellz", "Return credits Card Shellz paid vendors itself.",
    postedSource(["Σ amount_cents"], ["type = 'return_credit'"]), { opensMetric: "returns.credits_cs" }),
  "returns.credits_cs.inspected": line("cents", "inspected returns", "Credits for returns Card Shellz inspected.",
    postedSource(["Σ amount_cents"], ["type = 'return_credit'", "reference_type = 'dropship_rma'"]), { opensMetric: "returns.credits_cs" }),
  "returns.credits_cs.return_case": line("cents", "return cases", "Credits settled through a return case.",
    postedSource(["Σ amount_cents"], ["type = 'return_credit'", "reference_type = 'return_case_vendor_settlement'"]), { opensMetric: "returns.credits_cs" }),
  "returns.credits_pool": line("cents", "Credited from the insurance pool", "Return credits the insurance pool paid vendors.",
    postedSource(["Σ amount_cents"], ["type = 'insurance_pool_credit'"]), { opensMetric: "returns.credits_pool" }),
  "returns.credits_pool.no_inspection": poolCreditKind("no_inspection", "returns.credits_pool"),
  "returns.credits_pool.inspection_fault": poolCreditKind("inspection_fault", "returns.credits_pool"),
  "returns.credits_pool.return_case_fault": poolCreditKind("return_case_fault", "returns.credits_pool"),
  "returns.fees": line("cents", "Return fees charged to vendors", "Fees vendors paid on their returns.",
    postedSource(["−Σ amount_cents"], ["type = 'return_fee'"]), { opensMetric: "returns.fees" }),
  "returns.fees.restocking": line("cents", "restocking", "The restocking part of return fees.",
    FEE_PARTS_SOURCE("restocking_fee_cents", "restocking"), { opensMetric: "returns.fees" }),
  "returns.fees.processing": line("cents", "processing", "The processing part of return fees.",
    FEE_PARTS_SOURCE("processing_fee_cents", "processing"), { opensMetric: "returns.fees" }),
  "returns.fees.return_label": line("cents", "return label", "The return label part of return fees.",
    FEE_PARTS_SOURCE("return_shipping_fee_cents", "returnShipping"), { opensMetric: "returns.fees" }),
  "returns.fees.split_not_recorded": line("count", "split not recorded",
    "Return fees whose parts were not saved, so they can't be split.",
    source([LEDGER, SETTLEMENTS, INSPECTIONS], ["COUNT(*)"], [
      SETTLED, POSTED_IN_PERIOD, "type = 'return_fee'", "no settlement row and no inspection fee_breakdown->'fees'",
    ], POSTED_AT), { opensMetric: "returns.fees" }),
  "returns.net": line("cents", "Net credited to vendors", "Credits minus return fees.",
    postedSource(["Σ amount_cents (return fee entries are negative)"], ["type IN ('return_credit', 'insurance_pool_credit', 'return_fee')"])),
  "returns.staff_credits": line("cents", "Staff wallet credits (corrections, not cash)",
    "Credits staff added to wallets by hand, with the reason and the staff member on each.",
    depositSource(["Σ amount_cents", "COUNT(*)"], [`${RAIL} = 'manual'`, "reference_type = 'admin_manual_wallet_credit'"]),
    { opensMetric: "returns.staff_credits" }),
  "returns.memo.order_refunds": line("cents", "Order refunds: none",
    "Echelon has no way to refund an accepted order yet. Orders cancelled in OMS are listed in Checks.",
    notRecordedSource("type 'refund_credit' has no writer")),
  "returns.memo.restocked_value": line("cents", "value of returned items put back in stock",
    "The value of returned items put back in stock isn't saved.",
    notRecordedSource("no value column on restocked returns")),
  "returns.memo.return_label_cost": line("cents", "what we paid for return labels",
    "What we paid for return labels isn't saved.",
    notRecordedSource("no capture of the return label purchase")),
} satisfies Record<FinanceSectionLineKey<"returns">, FinanceLineDefinition>;

const BALANCE_NOW = (columns: readonly string[]) => source([ACCOUNTS], columns, [], null);

const OWED_LINES = {
  "owed.we_owe": line("cents", "We owe vendors (money in their wallets)",
    "Money in vendors' wallets right now: what we owe them.",
    BALANCE_NOW(["Σ GREATEST(available_balance_cents, 0)", "COUNT of wallets above zero"]), { opensMetric: "owed.vendors" }),
  "owed.they_owe": line("cents", "Vendors owe us (wallets below zero)",
    "Wallets below zero right now, for example after a fee or a dispute. Echelon doesn't record which one caused it.",
    BALANCE_NOW(["Σ GREATEST(−available_balance_cents, 0)", "COUNT of wallets below zero"]), { opensMetric: "owed.vendors" }),
  "owed.on_the_way": line("cents", "On the way (sent, not settled, not spendable)",
    "Bank transfers and USDC vendors sent that haven't settled. It is shown beside what we owe, never added to it.",
    BALANCE_NOW(["Σ pending_balance_cents"]), { opensMetric: "cash.on_the_way" }),
  "owed.wallets": line("count", "wallets", "Vendor wallets.", BALANCE_NOW(["COUNT(*)"]), { opensMetric: "owed.vendors" }),
  "owed.history_matches": line("cents", "Each wallet matches its history",
    "Wallets whose balance equals the sum of their settled history (check W1). The amount is the total difference.",
    source([ACCOUNTS, LEDGER], ["available_balance_cents vs Σ amount_cents", "Σ |difference| over wallets that differ"], [SETTLED, AVAILABLE_TYPES], null),
    { opensMetric: "check.W1" }),
  "owed.walk.opening": line("cents", "Owed on {date}", "What we owed vendors, net, when the period began, rebuilt from settled wallet history.",
    source([LEDGER], ["Σ amount_cents"], [SETTLED, AVAILABLE_TYPES, "settled_at before the period start"], SETTLED_AT), { opensMetric: "owed.walk" }),
  "owed.walk.deposits": walkMovement("Deposits credited to wallets", "Deposits that reached wallets in the period, staff credits aside.",
    `type = 'funding' AND ${RAIL} ≠ 'manual'`),
  "owed.walk.staff_credits": walkMovement("Staff wallet credits", "Credits staff added to wallets by hand.", `type = 'funding' AND ${RAIL} = 'manual'`),
  "owed.walk.return_credits_cs": walkMovement("Return credits (Card Shellz)", "Return credits Card Shellz paid into wallets.", "type = 'return_credit'"),
  "owed.walk.return_credits_pool": walkMovement("Return credits (insurance pool)", "Return credits the pool paid into wallets.", "type = 'insurance_pool_credit'"),
  "owed.walk.disputes_won": walkMovement("Disputes won: deposits restored", "What disputes we won put back in wallets, at the wallet amount.",
    "type = 'funding_reinstated'"),
  "owed.walk.orders": walkMovement("Orders paid from wallets", "What accepted orders took out of wallets.", "type = 'order_debit'"),
  "owed.walk.advance_fees": walkMovement("Advance fees", "Advance fees taken from wallets.", "type = 'advance_fee'"),
  "owed.walk.return_fees": walkMovement("Return fees", "Return fees taken from wallets.", "type = 'return_fee'"),
  "owed.walk.disputes_taken": walkMovement("Disputes: deposits taken back", "What disputes and bank returns took out of wallets, at the wallet amount.",
    "type = 'funding_reversal'"),
  "owed.walk.other": walkMovement("Other entries", "Entry types nothing should write; shown only when there are any (check N3).",
    "type IN ('refund_credit', 'manual_adjustment')"),
  "owed.walk.unexplained": line("cents", "Difference the entries don't explain",
    "What is left after the opening and every movement; shown only when it isn't zero, and check W4 lists it.",
    source([LEDGER], ["closing − opening − Σ movements"], [SETTLED, AVAILABLE_TYPES], SETTLED_AT), { opensMetric: "check.W4" }),
  "owed.walk.closing": line("cents", "Owed now", "What we owe vendors, net, at the end of the period: the opening plus every movement.",
    source([LEDGER], ["Σ amount_cents"], [SETTLED, AVAILABLE_TYPES, "settled_at before the period end"], SETTLED_AT),
    { opensMetric: "owed.walk", wordsAtEndOfPeriod: "Owed on {date}" }),
  "owed.walk.we_owe": line("cents", "we owe", "The closing split by wallet: what wallets above zero hold.",
    source([LEDGER], ["Σ over wallets of GREATEST(Σ amount_cents, 0)"], [SETTLED, AVAILABLE_TYPES, "settled_at before the period end"], SETTLED_AT),
    { opensMetric: "owed.walk" }),
  "owed.walk.they_owe": line("cents", "are owed", "The closing split by wallet: how far wallets below zero are under.",
    source([LEDGER], ["Σ over wallets of GREATEST(−Σ amount_cents, 0)"], [SETTLED, AVAILABLE_TYPES, "settled_at before the period end"], SETTLED_AT),
    { opensMetric: "owed.walk" }),
  "owed.walk.on_the_way": line("cents", "On the way at the end", "Deposits sent before the period ended that had not settled or failed by then.",
    source([LEDGER], ["Σ amount_cents"], [
      "type = 'funding'", "created_at before the period end", "not settled before the period end", "not failed before the period end",
    ], POSTED_AT), { opensMetric: "owed.walk" }),
} satisfies Record<FinanceSectionLineKey<"owed">, FinanceLineDefinition>;

const POINTS_LINES = {
  "points.opening": line("points", "Held on {date}", "Points vendors held when the period began, from the points history.",
    source([LEDGER], ["Σ amount_cents (1 point = 1¢)"], [SETTLED, REWARDS_TYPES, "created_at before the period start"], POSTED_AT),
    { opensMetric: "points.movements" }),
  "points.given": pointsMovement("rewards_earned", "Given on bank and USDC deposits", "Points vendors earned on deposits that settled.", "Σ"),
  "points.given.bank": line("points", "on bank transfers", "Points earned on bank transfers.",
    postedSource(["Σ amount_cents"], ["type = 'rewards_earned'", "metadata->>'rail' = 'stripe_ach'"]), { opensMetric: "points.movements" }),
  "points.given.card": line("points", "on card top-ups", "Points earned on card top-ups.",
    postedSource(["Σ amount_cents"], ["type = 'rewards_earned'", "metadata->>'rail' = 'stripe_card'"]), { opensMetric: "points.movements" }),
  "points.given.usdc": line("points", "on USDC", "Points earned on USDC deposits.",
    postedSource(["Σ amount_cents"], ["type = 'rewards_earned'", "metadata->>'rail' = 'usdc_base'"]), { opensMetric: "points.movements" }),
  "points.given.other": line("points", "on other deposits", "Points earned on deposits with any other way paid.",
    postedSource(["Σ amount_cents"], ["type = 'rewards_earned'", "metadata->>'rail' not stripe_ach, stripe_card or usdc_base"]), { opensMetric: "points.movements" }),
  "points.used": pointsMovement("rewards_spent", "Used to pay for orders", "Points vendors spent on orders.", "−Σ"),
  "points.used.billed_value": line("cents", "= {$} of billing", "What the points used are worth in what we billed: 1 point is 1¢.",
    postedSource(["−Σ amount_cents"], ["type = 'rewards_spent'"]), { opensMetric: "sales.paid_points" }),
  "points.expired": pointsMovement("rewards_expired", "Expired", "Points that ran out unused.", "−Σ"),
  "points.taken_back": pointsMovement("rewards_reversed", "Taken back after disputes", "Points taken back with a disputed or returned deposit.", "−Σ"),
  "points.given_back": pointsMovement("rewards_reinstated", "Given back after disputes we won", "Points returned when we won the dispute.", "Σ"),
  "points.held": line("points", "Held now",
    "Held at the start plus every movement in the period. When the period ends now it equals the points in vendors' wallets (check W3).",
    source([LEDGER], ["opening + given − used − expired − taken back + given back"], [SETTLED, REWARDS_TYPES], POSTED_AT),
    { opensMetric: "points.by_vendor", wordsAtEndOfPeriod: "Held at end of {date}" }),
  "points.held_now": line("points", "Held now in vendors' wallets",
    "Points in vendors' wallets right now. They must equal the points history and the points lots (check W3).",
    source([ACCOUNTS, REWARDS_LOTS], ["Σ dropship_wallet_accounts.rewards_balance_cents", "vs Σ dropship_wallet_rewards_lots.remaining_cents"], [], null),
    { opensMetric: "points.by_vendor" }),
  "points.memo.from_cash": line("cents", "Also recovered from cash on disputes",
    "Points that were already spent when their deposit was disputed, so the wallet's cash covered them instead.",
    postedSource(["Σ int(metadata->'rewardsClawback'->>'fromCashCents')"], ["type = 'funding_reversal'", WHOLE_CENTS]), { opensMetric: "cash.disputes" }),
  "points.expiry.next_30_days": expiryBucket("next 30 days",
    "Points still held that expire in the next 30 days, including lots past their date that the daily sweep has not expired yet.",
    "expires_at before now + 30 days"),
  "points.expiry.days_31_to_90": expiryBucket("31–90 days", "Points still held that expire 31 to 90 days from now.",
    "expires_at from now + 30 days to before now + 90 days"),
  "points.expiry.later": expiryBucket("later", "Points still held that expire more than 90 days from now.", "expires_at at now + 90 days or later"),
  "points.expiry.never": expiryBucket("never", "Points still held that never expire.", "expires_at IS NULL"),
} satisfies Record<FinanceSectionLineKey<"points">, FinanceLineDefinition>;

const POOL_LINES = {
  "pool.opening": line("cents", "In the pool on {date} (worked out)",
    "Set aside from orders before the period, minus pool payouts before it, plus top-ups before it.",
    source([ECONOMICS, LEDGER, POOL_LEDGER], [
      "Σ economics.insurance_pool_cents − Σ insurance_pool_credit entries + Σ pool top-ups",
    ], ["each before the period start", "insurance_pool_credit entries settled", "pool entry_type IN ('claim_replenishment', 'manual_adjustment')"],
    `${ACCEPTED_AT}; ${POSTED_AT}; ${POOL_LEDGER}.created_at`)),
  "pool.set_aside": line("cents", "Set aside from orders accepted {period}",
    "The insurance pool share of every order accepted in the period, costed or not.",
    ordersSource(["Σ insurance_pool_cents"]), { opensMetric: "pool.collected" }),
  "pool.paid_out": line("cents", "Paid out to vendors", "Return credits the pool paid vendors in the period.",
    postedSource(["−Σ amount_cents"], ["type = 'insurance_pool_credit'", "pool no_inspection_payout rows are never also subtracted"]),
    { opensMetric: "returns.credits_pool" }),
  "pool.paid_out.no_inspection": poolCreditKind("no_inspection", "returns.credits_pool"),
  "pool.paid_out.inspection_fault": poolCreditKind("inspection_fault", "returns.credits_pool"),
  "pool.paid_out.return_case_fault": poolCreditKind("return_case_fault", "returns.credits_pool"),
  "pool.topped_up": line("cents", "Topped up (carrier recoveries, staff adjustments)",
    "Money added to the pool in the period from carrier recoveries and staff adjustments.",
    source([POOL_LEDGER], ["Σ amount_cents"], ["entry_type IN ('claim_replenishment', 'manual_adjustment')", POSTED_IN_PERIOD], `${POOL_LEDGER}.created_at`),
    { opensMetric: "pool.replenished" }),
  "pool.closing": line("cents", "In the pool now (worked out)",
    "In the pool at the start, plus set aside, minus paid out, plus topped up. It can be below zero, and then it shows with a minus.",
    source([ECONOMICS, LEDGER, POOL_LEDGER], ["opening + set aside − paid out + topped up"], [], `${ACCEPTED_AT}; ${POSTED_AT}; ${POOL_LEDGER}.created_at`),
    { wordsAtEndOfPeriod: "In the pool at end of {date} (worked out)" }),
  "pool.claims": line("cents", "Carrier claims filed: {n} · {$} asked · none approved or paid yet",
    "Claims filed with carriers in the period and what they asked for. Claims stop at filing in Echelon today.",
    source([CLAIMS, INTAKE], ["Σ calculated_credit_cents", "COUNT(*) by status"], [POSTED_IN_PERIOD, "vendor through dropship_order_intake.vendor_id"], `${CLAIMS}.created_at`),
    { opensMetric: "pool.claims" }),
  "pool.record": line("cents", "The pool's own record shows {$}",
    "The sum of the pool's own entries. Order contributions and some payouts are never written to it, so it differs from the worked-out balance.",
    source([POOL_LEDGER], ["Σ amount_cents"], ["created_at before the period end"], `${POOL_LEDGER}.created_at`), { opensMetric: "pool.ledger" }),
} satisfies Record<FinanceSectionLineKey<"pool">, FinanceLineDefinition>;

const VENDOR_LINES = {
  "vendors.ordered": line("count", "vendors ordered", "Vendors with at least one order accepted in the period.",
    ordersSource(["COUNT(DISTINCT vendor_id)"]), { opensMetric: "vendors.all" }),
  "vendors.wallets": line("count", "wallets", "Vendor wallets.", BALANCE_NOW(["COUNT(*)"]), { opensMetric: "vendors.all" }),
} satisfies Record<FinanceSectionLineKey<"vendors">, FinanceLineDefinition>;

const INFO_LINES = {
  "info.overview_bridge.oms_row": line("cents", "Overview dashboard 'Dropship OMS' row",
    "The Overview dashboard's Dropship total: OMS order totals on the dropship channels, by order date, not cancelled.",
    source([OMS_ORDERS, INTAKE], ["Σ oms.oms_orders.total_cents::bigint"], [
      "channel_id of a dropship intake", "ordered_at within the period (Eastern wall-clock, no time zone stored)", "cancelled_at IS NULL",
    ], `${OMS_ORDERS}.ordered_at`)),
  "info.overview_bridge.billed": line("cents", "billed here", "Billed to vendors on this page.", ordersSource(["Σ total_debit_cents"]),
    { opensMetric: "sales.billed" }),
  "info.overview_bridge.leftover_pending": line("cents", "leftover pending orders",
    "OMS orders on dropship channels with no accepted order behind them.",
    source([OMS_ORDERS, ECONOMICS], ["Σ oms.oms_orders.total_cents::bigint"], ["no economics row with this oms_order_id", "ordered_at within the period", "cancelled_at IS NULL"],
      `${OMS_ORDERS}.ordered_at`)),
  "info.overview_bridge.cancelled_in_oms": line("cents", "orders cancelled in OMS",
    "Accepted orders later cancelled in OMS: billed here and left out of the Overview.",
    ordersSource(["Σ total_debit_cents"], [OMS_ORDERS], ["waiting reason cancelled_in_oms"]), { opensMetric: "sales.waiting" }),
  "info.overview_bridge.date_basis": line("cents", "order date vs accepted date difference",
    "What is left: orders placed in one period and accepted in another, and the Overview's own day boundaries.",
    source([OMS_ORDERS, ECONOMICS], ["OMS row − leftover pending − (billed − cancelled in OMS)"], [], null)),
  "info.pool_record.recorded": line("cents", "The pool's own record shows",
    "The sum of the pool's own entries up to the period end.",
    source([POOL_LEDGER], ["Σ amount_cents"], ["created_at before the period end"], `${POOL_LEDGER}.created_at`), { opensMetric: "pool.ledger" }),
  "info.pool_record.worked_out": line("cents", "the worked-out balance is",
    "The pool balance worked out from orders, payouts and top-ups (the Insurance pool row).",
    source([ECONOMICS, LEDGER, POOL_LEDGER], ["opening + set aside − paid out + topped up"], [], null)),
  "info.won_disputes.cash_returned": line("cents", "Cash returned (disputed amounts)",
    "What disputes we won returned, at the disputed amount of each paired pull-back.",
    postedSource(["Σ int(reversal.metadata->>'disputeAmountCents')"], ["type = 'funding_reinstated'"]), { opensMetric: "cash.disputes" }),
  "info.won_disputes.wallet_restored": line("cents", "wallet restored",
    "What those wins put back in wallets: the cash returned, less the card fee part, plus the points recovered from cash.",
    postedSource(["Σ amount_cents"], ["type = 'funding_reinstated'"]), { opensMetric: "cash.disputes" }),
  "info.won_disputes.card_fee_part": line("cents", "card fee part (dispute above the credit)",
    "Where a dispute was for more than the wallet was credited, the part above the credit.",
    postedSource(["Σ GREATEST(int(reversal.metadata->>'disputeAmountCents') − int(reversal.metadata->>'creditAmountCents'), 0)"], ["type = 'funding_reinstated'"]),
    { opensMetric: "cash.disputes" }),
  "info.won_disputes.points_from_cash": line("cents", "points recovered from cash",
    "Points that were already spent when the deposit was disputed, taken from the wallet's cash and given back with the win.",
    postedSource(["Σ int(reversal.metadata->'rewardsClawback'->>'fromCashCents')"], ["type = 'funding_reinstated'"]), { opensMetric: "cash.disputes" }),
} satisfies Record<FinanceInfoLineKey, FinanceLineDefinition>;

const ANCHOR_LINES = {
  "answer.kept": line("cents", "What we kept", SALES_LINES["sales.kept"].definition, SALES_LINES["sales.kept"].technicalSource),
  "answer.orders": line("count", "Orders accepted", "Orders we accepted in the period.", ordersSource(["COUNT(*)"]), { opensMetric: "sales.billed" }),
  "answer.coverage": line("count", "Costs complete on {x} of {y} orders",
    "Fully costed orders, of all orders accepted in the period.",
    fullyCostedSource(["COUNT(fully costed)", "of COUNT(*)"]), { opensMetric: "sales.waiting" }),
  "tiles.billed": line("cents", "Billed to vendors", SALES_LINES["sales.billed"].definition, SALES_LINES["sales.billed"].technicalSource,
    { opensMetric: "sales.billed" }),
  "tiles.cash_received": line("cents", "Cash received", CASH_LINES["cash.received"].definition, CASH_LINES["cash.received"].technicalSource,
    { opensMetric: "cash.deposits" }),
  "tiles.we_owe_now": line("cents", "We owe vendors · now", OWED_LINES["owed.we_owe"].definition, OWED_LINES["owed.we_owe"].technicalSource,
    { opensMetric: "owed.vendors" }),
  "tiles.owed_to_us_now": line("cents", "Vendors owe us · now", OWED_LINES["owed.they_owe"].definition, OWED_LINES["owed.they_owe"].technicalSource,
    { opensMetric: "owed.vendors" }),
  "info.overview_bridge": line("cents", "Why the Overview dashboard shows a different Dropship total",
    "The Overview's 'Dropship OMS' row minus billed here equals leftover pending orders, plus orders cancelled in OMS, plus the order date vs accepted date difference.",
    source([OMS_ORDERS, ECONOMICS, INTAKE], ["OMS row − billed = leftover pending + cancelled in OMS + date basis"], [], null)),
} satisfies Record<FinanceAnchorKey, FinanceLineDefinition>;

/** Every line key → its words, definition, unit, technical source and link. */
export const FINANCE_LINE_DEFINITIONS: Readonly<Record<FinanceLineKey, FinanceLineDefinition>> = Object.freeze({
  ...SALES_LINES,
  ...PRODUCT_LINES,
  ...CASH_LINES,
  ...RETURN_LINES,
  ...OWED_LINES,
  ...POINTS_LINES,
  ...POOL_LINES,
  ...VENDOR_LINES,
  ...INFO_LINES,
  ...ANCHOR_LINES,
});

/** The heading of the Sales memo that lists what is not taken off. */
export const FINANCE_NOT_TAKEN_OFF_HEADING = "Not taken off what we kept:";
/** The heading of the points expiry line. */
export const FINANCE_POINTS_EXPIRY_HEADING = "Expiring:";

// ── reasons a line is not recorded, partial or unavailable (spec §7, §10) ─

export type FinanceReasonKind = "not_recorded" | "partial" | "unavailable" | "basis";

export interface FinanceReasonDefinition extends FinanceDefinition {
  readonly kind: FinanceReasonKind;
}

function reason(kind: FinanceReasonKind, words: string, definition: string, technicalSource: FinanceTechnicalSource): FinanceReasonDefinition {
  return Object.freeze({ kind, words, definition, technicalSource });
}

export const FINANCE_REASON_DEFINITIONS = Object.freeze({
  // Not recorded: no table holds it (spec §11 "Data that needs new capture").
  packaging_not_saved: reason("not_recorded", "Box and mailer costs are not saved per package.",
    "Packaging is not taken off what we kept because there is no packaging cost to take.",
    notRecordedSource("no writer saves dunnage_cost_cents or a per-package box cost")),
  stripe_fees_not_saved: reason("not_recorded", "Echelon doesn't save Stripe's processing or dispute fees.",
    "Cash received is before Stripe's fees.", notRecordedSource("Stripe balance transactions are not ingested")),
  usdc_moves_not_saved: reason("not_recorded", "Moves of USDC out of deposit addresses aren't recorded.",
    "USDC counts when it settles in a deposit address; what happens to it afterwards is not on this page.",
    notRecordedSource("no treasury record of USDC sweeps or conversions")),
  return_label_cost_not_saved: reason("not_recorded", "What we paid for return labels isn't saved.",
    "Return label fees vendors paid are shown; what the labels cost us is not.", notRecordedSource("no capture of the return label purchase")),
  restocked_value_not_saved: reason("not_recorded", "The value of returned items put back in stock isn't saved.",
    "Returned stock is not valued on this page.", notRecordedSource("no value column on restocked returns")),
  no_refund_path: reason("not_recorded", "Echelon has no way to refund an accepted order yet. Orders cancelled in OMS are listed in Checks.",
    "There are no order refunds to show.", notRecordedSource("type 'refund_credit' has no writer")),
  dispute_outcome_not_saved: reason("not_recorded", "Echelon can't tell a dispute that's still open from one we lost.",
    "Disputes not won back are shown together.", notRecordedSource("the dispute outcome is not persisted")),
  claims_stop_at_filing: reason("not_recorded", "Claims stop at filing in Echelon today.",
    "No carrier claim has an approval or payout to show.", source([CLAIMS], ["status"], ["no approval or payout step exists"], null)),
  overheads_not_on_page: reason("not_recorded", "Overheads are not on this page.",
    "Costs of running Card Shellz that no order carries are not taken off what we kept.", notRecordedSource("overheads are outside the dropship records")),
  // Partial: some rows could not be counted; the line shows what could.
  pieces_not_recorded: reason("partial", "pieces not recorded on {n} lines",
    "Lines with no catalog size have no pieces per pack, so they are left out of pieces.",
    source([OMS_LINES, VARIANTS], ["catalog.product_variants.units_per_variant"], ["oms.oms_order_lines.product_variant_id with no catalog row"], ACCEPTED_AT)),
  split_not_recorded: reason("partial", "split not recorded",
    "Some return fees have no saved parts, so the parts don't add up to the whole.",
    source([SETTLEMENTS, INSPECTIONS], ["fee_breakdown->'fees'"], ["no settlement row and no inspection fee breakdown"], POSTED_AT)),
  buyer_total_unknown: reason("partial", "({n} unknown)",
    "Some orders have no buyer total saved, so they are left out of what buyers paid.",
    source([INTAKE], ["normalized_payload->'totals'->>'grandTotalCents'"], ["missing or not whole cents"], ACCEPTED_AT)),
  quote_missing: reason("partial", "Some orders have no saved shipping quote.",
    "Their carrier estimate and markup are missing, so those parts don't add up to shipping.",
    source([ECONOMICS, QUOTES], ["shipping_quote_snapshot_id"], ["no dropship_shipping_quote_snapshots row"], ACCEPTED_AT)),
  metadata_malformed: reason("partial", "Some stored amounts aren't whole cents. Checks lists them.",
    "Amounts stored in deposit and dispute details that aren't whole cents are never counted as zero; check D7 lists each one.",
    source([LEDGER], ["metadata chargedCents, cardFeeCents, disputeAmountCents, rewardsClawback.fromCashCents"], [WHOLE_CENTS], POSTED_AT)),
  dispute_amount_missing: reason("partial", "Some disputes have no disputed amount saved. Checks lists them.",
    "Those pull-backs are left out of the disputed total; check D7 lists each one.",
    source([LEDGER], ["metadata->>'disputeAmountCents'"], ["type = 'funding_reversal'", "missing or not whole cents"], POSTED_AT)),
  reversal_not_paired: reason("partial", "Some won disputes can't be matched to their pull-back. Checks lists them.",
    "Without the pull-back there is no disputed amount to count; check D7 lists each one.",
    source([LEDGER], ["metadata->>'reversalLedgerEntryId'", "reference_id"], ["type = 'funding_reinstated'", "no paired funding_reversal"], POSTED_AT)),
  failure_time_missing: reason("partial", "Some failed deposits have no failure time saved. Checks lists them.",
    "Without a failure time they can't be placed in a period; check D7 lists each one.",
    source([LEDGER], ["metadata->'failure'->>'failedAt'"], ["status = 'failed'", "missing or not ISO text"], null)),
  // Unavailable: the number can't be worked out here.
  program_wide: reason("unavailable", "The pool balance is for the whole program; it isn't split by vendor.",
    "In a vendor's view, figures that belong to the whole program are not shown.", source([POOL_LEDGER], ["entries carry no vendor"], [], null)),
  table_missing: reason("unavailable", "This data isn't set up here.",
    "A table this number needs does not exist in this database (check P2 lists it).", source([], ["to_regclass(<table>) IS NULL"], [], null)),
  amount_out_of_range: reason("unavailable", "This amount is too large to show exactly, so it isn't shown.",
    "A total beyond what can be sent exactly is withheld rather than rounded.", source([], ["Number.isSafeInteger(total) is false"], [], null)),
  // Basis notes: how a recorded number is meant (spec §10 "Not recorded reasons" list).
  current_cost: reason("basis",
    "Cost of goods uses today's cost of the stock each order used (oldest stock first). If a lot's cost is finalised later, past months can change.",
    "Cost of goods is the current lot cost, not a frozen copy.", source([ITEM_COSTS, INVENTORY_LOTS, PICK_MOVEMENTS], [COGS_MILLS], [], ACCEPTED_AT)),
  buyers_paid: reason("basis",
    "What buyers paid the vendors on eBay and Shopify. This is the vendors' sale, not Card Shellz money. An eBay total can include the vendor's own items.",
    "Buyer totals are context only.", source([INTAKE], ["normalized_payload->'totals'"], [], ACCEPTED_AT)),
  advance: reason("basis", "We let an order through before the vendor's bank transfer cleared and charged a small fee for it.",
    "An advance fee is a fee we charged.", source([LEDGER], ["type = 'advance_fee'", "order_debit metadata->'advance'"], [], POSTED_AT)),
  pool_record_incomplete: reason("basis",
    "Order contributions and some payouts are never written to the pool's own record, so this balance is worked out from orders, payouts and top-ups.",
    "The pool balance is worked out, not read from one table.", source([POOL_LEDGER, ECONOMICS, LEDGER], ["see the Insurance pool row"], [], null)),
} satisfies Record<string, FinanceReasonDefinition>);

export type FinanceReasonKey = keyof typeof FINANCE_REASON_DEFINITIONS;
export const FINANCE_REASON_KEYS = Object.freeze(Object.keys(FINANCE_REASON_DEFINITIONS) as FinanceReasonKey[]);

export function isFinanceReasonKey(value: string): value is FinanceReasonKey {
  return Object.prototype.hasOwnProperty.call(FINANCE_REASON_DEFINITIONS, value);
}

// ── clock chips (datedBy) ────────────────────────────────────────────────

export const FINANCE_DATED_BY_DEFINITIONS: Readonly<Record<FinanceDatedBy, FinanceDefinition>> = Object.freeze({
  accepted: { words: "day accepted", definition: "Counted on the day we accepted the order, Eastern time.", technicalSource: source([ECONOMICS], ["created_at"], [], ACCEPTED_AT) },
  settled: { words: "day it settled", definition: "Counted on the day the deposit settled, Eastern time.", technicalSource: source([LEDGER], ["settled_at"], ["type = 'funding'"], SETTLED_AT) },
  posted: { words: "day posted", definition: "Counted on the day the wallet entry was posted, Eastern time.", technicalSource: source([LEDGER], ["created_at"], [], POSTED_AT) },
  received: { words: "day received", definition: "Counted on the day the order reached Echelon, Eastern time.", technicalSource: source([INTAKE], ["received_at"], [], RECEIVED_AT) },
  now: { words: "right now", definition: "A balance as it stands when the page was worked out.", technicalSource: source([ACCOUNTS, REWARDS_LOTS], ["current balances"], [], null) },
  end_of_period: { words: "at end of period", definition: "A balance rebuilt as it stood when the period ended, from settled history.", technicalSource: source([LEDGER], ["Σ amount_cents"], [SETTLED, "settled_at before the period end"], SETTLED_AT) },
});

// ── sections (spec §3.4, §10) ────────────────────────────────────────────

export type FinanceSectionGroup = "orders" | "money" | "balances" | "program";

export interface FinanceSectionDefinition {
  readonly title: string;
  /** The clock chip beside the title. */
  readonly chip: string;
  readonly group: FinanceSectionGroup;
  /** The collapsed row's muted one-line summary. */
  readonly summary: string;
  /** The collapsed row's one amount. */
  readonly amount: string;
  /** The line whose amount the collapsed row shows (null: a vendor name for Vendors). */
  readonly amountLineKey: FinanceLineKey | null;
}

export const FINANCE_SECTION_DEFINITIONS: Readonly<Record<FinanceSectionKey, FinanceSectionDefinition>> = Object.freeze({
  sales: { title: "Sales and what we kept", chip: "day accepted", group: "orders", summary: "{n} orders · {w} waiting on costs", amount: "{$} kept", amountLineKey: "sales.kept" },
  products: { title: "Products sold", chip: "day accepted", group: "orders", summary: "{packs} packs · {pieces} pieces · {n} products", amount: "{$} billed for product", amountLineKey: "products.billed" },
  cash: { title: "Cash in", chip: "day it moved", group: "money", summary: "{n} deposits · {rails}", amount: "{$} received", amountLineKey: "cash.received" },
  returns: { title: "Returns and credits", chip: "day posted", group: "money", summary: "{n} credits · {$} in return fees", amount: "{$} credited", amountLineKey: "returns.credited" },
  owed: { title: "What we owe and are owed", chip: "right now", group: "balances", summary: "right now · {n} wallets", amount: "{$} we owe", amountLineKey: "owed.we_owe" },
  points: { title: "Points (rewards)", chip: "day it moved · held now", group: "balances", summary: "1 point = 1¢ off orders · never paid out", amount: "{n} points held", amountLineKey: "points.held" },
  pool: { title: "Insurance pool", chip: "accepted + moved", group: "balances", summary: "set aside for lost parcels, not profit", amount: "{$} in the pool", amountLineKey: "pool.closing" },
  vendors: { title: "Vendors", chip: "accepted + moved + now", group: "program", summary: "{n} vendors ordered · {m} wallets", amount: "{name} kept most", amountLineKey: null },
});

export const FINANCE_SECTION_GROUP_CAPTIONS: Readonly<Record<FinanceSectionGroup, string>> = Object.freeze({
  orders: "Orders accepted {period}",
  money: "Money that moved {period}",
  balances: "Balances",
  program: "Across the program",
});

/** The ninth detail row: the Checks list (spec §3.4 I). */
export const FINANCE_CHECKS_ROW = Object.freeze({
  title: "Checks",
  summary: "{x} of {y} fine",
  allFine: "All fine",
  needALook: "{n} need a look",
});

export const FINANCE_SECTION_STATUS_WORDS: Readonly<Record<Exclude<FinanceSectionStatus, "ok">, string>> = Object.freeze({
  error: "Couldn't work out {section}: {code}.",
  skipped: "Took too long; try a shorter period.",
});

export const FINANCE_LINE_STATUS_WORDS: Readonly<Record<FinanceLineStatus, string>> = Object.freeze({
  recorded: "Recorded",
  not_recorded: "Not recorded",
  partial: "Some amounts missing",
  unavailable: "Unavailable",
});

// ── checks (spec §8, contract §3) ────────────────────────────────────────

export interface FinanceCheckDefinition {
  readonly group: FinanceCheckGroup;
  /** The plain sentence on the Checks list (spec §8 wording column, verbatim). */
  readonly wording: string;
  readonly definition: string;
  readonly scope: FinanceCheckScope;
  /** Program-only checks read "Program-wide: see all vendors" in a vendor's view. */
  readonly programOnly: boolean;
  /** Where the amber dot goes when the check needs a look (at most FINANCE_CHECK_OWNER_LINES_MAX). */
  readonly ownerLineKeys: readonly FinanceLineKey[];
  readonly technicalSource: FinanceTechnicalSource;
}

function check(
  group: FinanceCheckGroup,
  scope: FinanceCheckScope,
  wording: string,
  definition: string,
  ownerLineKeys: readonly FinanceLineKey[],
  technicalSource: FinanceTechnicalSource,
  programOnly = false,
): FinanceCheckDefinition {
  return Object.freeze({ group, wording, definition, scope, programOnly, ownerLineKeys: Object.freeze([...ownerLineKeys]), technicalSource });
}

export const FINANCE_CHECK_DEFINITIONS: Readonly<Record<FinanceCheckId, FinanceCheckDefinition>> = Object.freeze({
  W1: check("wallets", "now", "Each wallet's balance matches its history",
    "Every wallet's balance equals the sum of its settled entries that move the balance (recon 1).",
    ["tiles.we_owe_now", "tiles.owed_to_us_now", "owed.we_owe", "owed.they_owe", "owed.history_matches"],
    source([ACCOUNTS, LEDGER], ["available_balance_cents vs Σ amount_cents"], [SETTLED, AVAILABLE_TYPES, "ledger vendors with no wallet are exceptions"], null)),
  W2: check("wallets", "now", "Money on the way matches the deposits still waiting to settle",
    "Every wallet's on-the-way balance equals its deposits still pending (recon 2).",
    ["owed.on_the_way", "cash.memo.on_the_way"],
    source([ACCOUNTS, LEDGER], ["pending_balance_cents vs Σ amount_cents"], ["type = 'funding'", "status = 'pending'"], null)),
  W3: check("wallets", "now", "Points held match the points history and the points lots",
    "Every wallet's points equal its settled points history and its points lots; reconciled lots are listed (recon 3).",
    ["points.held_now", "points.held"],
    source([ACCOUNTS, LEDGER, REWARDS_LOTS, AUDIT_EVENTS], ["rewards_balance_cents vs Σ rewards entries vs Σ remaining_cents"], [
      SETTLED, REWARDS_TYPES, "lots with source 'reconciled' and 'wallet_rewards_lots_reconciled' events are listed, not exceptions",
    ], null)),
  W4: check("wallets", "period", "The balance walk since the period start closes",
    "For every wallet, the balance at the start plus each movement in the period equals the balance at the end, and the end equals the wallet now when the period ends now (recon 1).",
    ["owed.walk.closing", "owed.walk.unexplained"],
    source([LEDGER, ACCOUNTS], ["before start + Σ movements vs before end"], [SETTLED, AVAILABLE_TYPES, "settled entries other than deposits have settled_at = created_at"], SETTLED_AT)),
  O1: check("orders", "period", "Each order's wallet and points payments equal what we billed and the OMS order total",
    "For every accepted order, wallet plus points payments, the OMS order total and the recorded total all equal what we billed, and the advance fee matches its record (recon 4).",
    ["tiles.billed", "sales.billed.paid_from_wallets", "sales.billed.paid_with_points"],
    ordersSource(["−(order_debit + rewards_spent) vs total_debit_cents", "oms.oms_orders.total_cents", "metadata totalDebitCents (written from 2026-09-24)", "advance fee"], [LEDGER, OMS_ORDERS])),
  O2: check("orders", "period", "What we billed equals product plus shipping, with no hidden fee",
    "For every accepted order, what we billed equals product plus shipping, and the fees field is zero (recon 5).",
    ["sales.billed"], ordersSource(["total_debit_cents = wholesale_subtotal_cents + shipping_cents + fees_cents", "fees_cents = 0"])),
  O3: check("orders", "period", "Shipping equals carrier estimate + markup + packaging (zero) + pool share",
    "For every accepted order, shipping equals its quote, and the quote is carrier estimate plus markup plus packaging (zero) plus pool share (recon 6).",
    ["sales.billed.shipping"],
    ordersSource(["shipping_cents = quote total", "quote total = base_rate + markup + dunnage + insurance_pool", "dunnage_cents = 0"], [QUOTES], [QUOTE_JOIN])),
  O4: check("orders", "period", "Product billed equals the OMS lines and the priced lines; no tax or discount on our side",
    "For every accepted order, product billed equals the OMS order subtotal, its lines and the priced lines, shipping equals the OMS shipping, and OMS tax and discount are zero (recon 7).",
    ["sales.billed.product", "products.billed"],
    ordersSource(["wholesale_subtotal_cents vs oms subtotal, Σ line totals, Σ pricing_snapshot wholesale lines", "oms tax = 0, discount = 0"], [OMS_ORDERS, OMS_LINES])),
  O5: check("orders", "period", "Order counts agree (accepted, priced, charged, paid in OMS) and their times match",
    "Every accepted order is accepted on its intake, charged at the same moment and paid in OMS, and every accepted intake has its economics row (recon 8).",
    ["answer.orders"],
    ordersSource(["intake status and accepted_at", "payment entries created_at", "oms financial_status = 'paid'", "intake.oms_order_id = economics.oms_order_id"], [INTAKE, LEDGER, OMS_ORDERS])),
  O6: check("orders", "period", "Pack counts agree, and no order shipped more packs than it accepted",
    "For every accepted order, OMS line packs equal the priced packs and the buyer's packs, and packs shipped are no more than packs ordered (recon 19).",
    ["products.packs"],
    ordersSource(["Σ oms.oms_order_lines.quantity vs pricing_snapshot lines vs normalized_payload lines", "packs shipped ≤ packs ordered"], [OMS_LINES, INTAKE, SHIPMENTS, SHIPMENT_ITEMS])),
  D1: check("deposits", "period", "Card deposits: charged = credited + card fee; top-up runs agree and are never added twice",
    "Every deposit in the period with a charged amount equals the amount credited plus its card fee, and every top-up run agrees with its entry (recon 11).",
    ["cash.card", "sales.fees.card"],
    source([LEDGER, MAINTENANCE_RUNS], [
      "int(metadata->>'chargedCents') = amount_cents + int(metadata->>'cardFeeCents')",
      "runs: charged_cents = amount_cents + card_fee_cents, amount_cents = the entry's amount_cents; runs are never added to totals",
    ], ["type = 'funding'", SETTLED, SETTLED_IN_PERIOD, WHOLE_CENTS], SETTLED_AT)),
  D2: check("deposits", "period", "Points given on each deposit follow its rate, at most once per deposit",
    "Every points grant in the period belongs to a settled deposit, matches that deposit's amount times its rate, and no deposit has two (recon 12).",
    ["points.given"],
    postedSource(["amount_cents = (deposit amount × rateBps) ÷ 10000", "one per reference_id"], ["type = 'rewards_earned'", "reference_type = 'wallet_funding_rewards'"])),
  D3: check("deposits", "period", "Every dispute pull-back and win pairs up; no pull-back is larger than its deposit",
    "Every pull-back in the period pairs with its deposit and, when won, with its win; disputes not won back are listed, not exceptions (recon 13).",
    ["cash.pulled_back", "cash.won_back"],
    postedSource(["reinstated = −reversal", "−reversal − fromCash ≤ deposit amount"], ["type IN ('funding_reversal', 'funding_reinstated', 'rewards_reversed', 'rewards_reinstated')"])),
  D4: check("deposits", "period", "USDC: one credit per transfer, the right amount, matching status, never credited twice",
    "Every USDC deposit in the period has exactly one chain record with the same amount and a matching status, and no transfer is credited twice (recon 14).",
    ["cash.usdc"],
    source([LEDGER, USDC_ENTRIES], ["amount_cents = amount_atomic_units ÷ 10000", "status pairs pending/pending, settled/settled, failed/voided", "one wallet entry per (chain_id, transaction hash)"], [
      "reference_type = 'usdc_base_transaction'",
    ], SETTLED_AT)),
  D5: check("deposits", "all_time", "Retired weekly collections match their deposits",
    "Every successful weekly collection has its deposit, marked as a collection, for the same amount (recon 20).",
    ["cash.collection"],
    source([COLLECTION_ATTEMPTS, LEDGER], ["amount_cents = wallet entry amount_cents", "wallet entry type 'funding' with metadata collection = 'true'"], ["status = 'succeeded'"], null)),
  D6: check("deposits", "now", `No deposit has waited more than ${FINANCE_STALE_PENDING_DEPOSIT_DAYS} days, and every deposit has a way paid`,
    `No deposit is still on the way more than ${FINANCE_STALE_PENDING_DEPOSIT_DAYS} days after it was sent, and no deposit lacks a way paid (recon 21).`,
    ["cash.memo.stuck", "cash.unknown"],
    source([LEDGER, FUNDING_METHODS], ["COUNT(*)"], [
      `type = 'funding' AND status = 'pending' AND created_at before now − ${FINANCE_STALE_PENDING_DEPOSIT_DAYS} days`, `${RAIL} = 'unknown'`,
    ], POSTED_AT)),
  D7: check("deposits", "period", "Every amount stored in deposit and dispute details is a whole number of cents",
    "No amount stored in a deposit's or dispute's details fails to read as whole cents, no failed deposit lacks its failure time, and every win pairs with its pull-back.",
    ["cash.received_deposits", "cash.pulled_back", "cash.won_back", "cash.memo.failed", "sales.fees.card", "points.memo.from_cash"],
    source([LEDGER], ["metadata chargedCents, cardFeeCents, disputeAmountCents, rewardsClawback.fromCashCents, failure.failedAt"], [WHOLE_CENTS], POSTED_AT)),
  K1: check("costs", "period", "Label costs are consistent: combined labels counted once, voided labels holding a cost listed, shipping splits add up",
    "Every package's cost source matches its cost, voided packages holding a cost are listed, and every order's shipping split adds up to its shipping (recon 17).",
    ["sales.labels"],
    source([...ORDER_TABLES, ALLOCATIONS], [
      "(carrier_cost_source IS NOT NULL) = (carrier_cost_cents > 0)", "Σ allocated_shipping_charge_cents = economics.shipping_cents",
      "labels shared by more than one package row are counted once and listed",
    ], [ACCEPTED_IN_PERIOD, WMS_JOIN, PACKAGE_STATUSES, "voided packages holding a cost are listed"], ACCEPTED_AT)),
  K2: check("costs", "period", "Cost-of-goods rows add up, and every picked or shipped line has a cost",
    "Every cost row's total equals its packs times its unit cost, every picked or shipped line has a cost row, and cost rows linked to no line are listed (recon 18).",
    ["sales.cogs"],
    source([...ORDER_TABLES, PICK_MOVEMENTS], ["total_cost_mills = qty × unit_cost_mills", "lines picked or shipped with no cost row"], [ACCEPTED_IN_PERIOD, WMS_JOIN], ACCEPTED_AT)),
  K3: check("costs", "all_time", `No order has waited more than ${FINANCE_COST_WAIT_ALERT_DAYS} days for its costs`,
    `No order accepted more than ${FINANCE_COST_WAIT_ALERT_DAYS} days ago is still waiting for its costs, in any period.`,
    ["answer.coverage"],
    source(ORDER_TABLES, ["COUNT(*) with a waiting reason"], [`economics.created_at before now − ${FINANCE_COST_WAIT_ALERT_DAYS} days`], ACCEPTED_AT)),
  R1: check("returns_pool", "period", "Return settlements and inspections match their wallet credits and fees; no order credited twice for the same items",
    "Every return settlement and inspection in the period has the wallet credit and fee it records, no order is credited by both return paths, and no order is credited more than it was billed (recon 16).",
    ["returns.credits_cs", "returns.credits_pool", "returns.fees"],
    source([SETTLEMENTS, INSPECTIONS, RMAS, RETURN_CASES, LEDGER, ECONOMICS], ["credit = gross", "fee = −total fee"], [
      "reference_id '<id>:credit' and '<id>:fee'", POSTED_IN_PERIOD,
    ], POSTED_AT)),
  R2: check("returns_pool", "all_time", "Each no-inspection pool payout mirrors its wallet credit",
    "Every no-inspection payout in the pool's record has the wallet credit it mirrors, for the same amount (recon 15).",
    ["pool.paid_out"],
    source([POOL_LEDGER, LEDGER], ["wallet entry amount_cents = −pool amount_cents", "wallet entry type 'insurance_pool_credit'"], ["entry_type = 'no_inspection_payout'"], null)),
  N1: check("never", "all_time", "No accepted order was cancelled in OMS while the vendor stays charged",
    "No order we charged for has been cancelled in OMS (recon 9).",
    ["sales.billed", "sales.waiting.cancelled_in_oms"],
    source([ECONOMICS, OMS_ORDERS], ["COUNT(*)"], ["oms.oms_orders.cancelled_at IS NOT NULL OR status = 'cancelled'"], null)),
  N2: check("never", "all_time", "No leftover OMS orders from payment holds that ran out",
    "No intake that ended without a charge left an OMS order pending (recon 9).",
    ["info.overview_bridge"],
    source([INTAKE, OMS_ORDERS, ECONOMICS], ["COUNT(*)"], [
      "intake status IN ('cancelled', 'rejected', 'failed', 'exception')", "oms status 'pending' and financial_status 'pending'", "no economics row",
    ], null), true),
  N3: check("never", "all_time", "No unexpected wallet entry types or statuses",
    "No wallet entry has a type nothing should write, an unexpected status, a settled entry without a settle time, or a settle time that differs from its post time (recon 9).",
    ["owed.walk.other"],
    source([LEDGER], ["COUNT(*)"], [
      "type IN ('refund_credit', 'manual_adjustment')", "status 'voided', or not settled for a type other than funding", "settled with no settled_at", "settled_at ≠ created_at outside deposits",
    ], null)),
  P1: check("page", "period", "Every list adds up to its line, each row is counted once, whole cents throughout",
    "The page's own identities hold: the bar adds up to billed, each statement closes, each table adds up to its line, and each walk closes (recon 22).",
    ["answer.kept", "sales.kept_orders", "cash.received", "owed.walk.closing", "points.held", "pool.closing"],
    source([], ["14 identities over the summary itself (contract §3 P1)"], [], null)),
  P2: check("page", "now", "Every data source this page needs is set up here",
    "Every table the page reads exists in this database.", [],
    source([], ["to_regclass(<table>) IS NOT NULL for every table read"], [], null), true),
});

export const FINANCE_CHECK_GROUP_WORDS: Readonly<Record<FinanceCheckGroup, string>> = Object.freeze({
  wallets: "Wallets",
  orders: "Orders",
  deposits: "Deposits",
  costs: "Costs",
  returns_pool: "Returns and pool",
  never: "Should never happen",
  page: "Page",
});

export const FINANCE_CHECK_RESULT_WORDS: Readonly<Record<FinanceCheckResult, string>> = Object.freeze({
  fine: "Fine",
  needs_a_look: "Needs a look",
  could_not_check: "Couldn't check",
  program_wide: "Program-wide: see all vendors",
});

// ── information lines (spec §8) ──────────────────────────────────────────

export const FINANCE_INFO_DEFINITIONS: Readonly<Record<FinanceInfoKey, FinanceDefinition>> = Object.freeze({
  overview_bridge: {
    words: "Why the Overview dashboard shows a different Dropship total",
    definition: ANCHOR_LINES["info.overview_bridge"].definition,
    technicalSource: ANCHOR_LINES["info.overview_bridge"].technicalSource,
  },
  pool_record: {
    words: "The pool's own record shows {$}; the worked-out balance is {$} because order contributions and carrier-fault payouts are never written to it",
    definition: "The pool's own entries leave out order contributions and some payouts, so the page works the balance out instead.",
    technicalSource: source([POOL_LEDGER, ECONOMICS, LEDGER], ["Σ pool entries vs worked-out balance"], ["created_at before the period end"], `${POOL_LEDGER}.created_at`),
  },
  won_disputes: {
    words: "Cash returned (disputed amounts) {$} vs wallet restored {$}",
    definition: "Disputes we won count as cash at the disputed amount (owner decision 13); the wallet got back that amount, less the card fee part, plus points recovered from cash.",
    technicalSource: source([LEDGER], ["disputed − restored = card fee part − points recovered from cash"], ["type = 'funding_reinstated'", POSTED_IN_PERIOD], POSTED_AT),
  },
});

// ── policy-era notes (contract §2.10, spec §7) ───────────────────────────

export interface FinanceNoteDefinition extends FinanceDefinition {
  /** First Eastern day the era covers, inclusive; null when it has no start on record. */
  readonly firstDate: string | null;
  /** Last Eastern day the era covers, inclusive; null when it is still running. */
  readonly lastDate: string | null;
}

/**
 * A note shows when the period's Eastern days overlap [firstDate, lastDate].
 * The dates come from the commits and migrations cited in each source;
 * a boundary day counts as inside the era, so a period touching it gets the note.
 */
export const FINANCE_NOTE_DEFINITIONS: Readonly<Record<FinanceNoteKey, FinanceNoteDefinition>> = Object.freeze({
  card_fee_era: {
    words: "Card top-ups carried a 3% fee from Sep 16 to Sep 24, 2026.",
    definition: "Card top-ups in those days carried a 3% fee, so card fees are not zero then.",
    firstDate: "2026-09-16",
    lastDate: "2026-09-24",
    technicalSource: source([LEDGER, MAINTENANCE_RUNS], ["metadata cardFeeCents / cardFeeBps = 300", "card_fee_cents"], [
      "3% from commit ab016846 (2026-09-16)", "0% from migration 0701_dropship_wallet_card_fee_policy.sql (2026-09-24)",
    ], SETTLED_AT),
  },
  pricing_v1_era: {
    words: "Orders before Sep 13, 2026 used older pricing.",
    definition: "Orders accepted before then were priced with the first pricing rules (catalog price minus a partner discount).",
    firstDate: null,
    lastDate: "2026-09-12",
    technicalSource: source([ECONOMICS], ["pricing_snapshot->>'version' = 1"], ["version 2 from commit 6e08f66f (2026-09-13)"], ACCEPTED_AT),
  },
  weekly_collection_era: {
    words: "The weekly collection ran from Aug 5 to Sep 17, 2026 (retired).",
    definition: "A weekly sweep took money from vendors in those weeks; it was replaced by the daily wallet run.",
    firstDate: "2026-08-05",
    lastDate: "2026-09-17",
    technicalSource: source([COLLECTION_ATTEMPTS, LEDGER], ["funding entries with metadata collection = 'true'"], [
      "from commit bda47b88 (about 2026-08-05) to commit fdb374ea (2026-09-17)",
    ], SETTLED_AT),
  },
});

// ── "How this page counts": the frame, the money path, the defaults ──────

/** The sentence under the period bar (spec §10 "Two clocks"). */
export const FINANCE_TWO_CLOCKS_SENTENCE = "Orders count on the day we accepted them. Money counts on the day it moved. Eastern time.";

/** The money path, drawn as a plain diagram in "How this page counts" (spec §1). */
export const FINANCE_MONEY_PATH_STEPS: readonly string[] = Object.freeze([
  "Vendors pay in",
  "It sits in their wallets as money we owe them",
  "Each accepted order moves part of it to us",
  "Billing pays for products, labels and the pool share",
  "The rest is what we kept",
]);

export interface FinanceCountingChoice {
  readonly key: string;
  readonly words: string;
  readonly technical: string;
  /** True for the one choice the owner still has to sign off (spec §1.1 #13). */
  readonly needsSignOff: boolean;
}

export const FINANCE_COUNTING_CHOICES: readonly FinanceCountingChoice[] = Object.freeze([
  { key: "staff_only", words: "Only staff with Dropship operations access (Administrator) can see this page.",
    technical: "requirePermission('dropship', 'manage_operations') on every /api/dropship/admin/finance route", needsSignOff: false },
  { key: "time_zone", words: "Days and months follow Eastern time. The page opens on this month so far, compared with the same span of last month.",
    technical: "America/New_York; period bounds are Eastern midnights (timestamp AT TIME ZONE 'America/New_York')", needsSignOff: false },
  { key: "two_clocks", words: "Orders and their costs count on the day we accepted them. Money counts on the day it moved: deposits when they settled, everything else when it was posted.",
    technical: `orders: ${ACCEPTED_AT}; deposits: ${SETTLED_AT}; other wallet entries: ${POSTED_AT}`, needsSignOff: false },
  { key: "billed", words: "What we billed is product plus shipping, with the insurance pool share already inside shipping.",
    technical: `${ECONOMICS}.total_debit_cents`, needsSignOff: false },
  { key: "pool_reserve", words: "The insurance pool is a reserve, not profit.",
    technical: "the pool share is taken off kept on orders and has its own row", needsSignOff: false },
  { key: "current_cost", words: "Cost of goods is today's cost of the stock each order used (oldest stock first), so past months can change.",
    technical: COGS_MILLS, needsSignOff: false },
  { key: "voided_labels", words: "Voided labels count as $0.00.",
    technical: PACKAGE_STATUSES, needsSignOff: false },
  { key: "combined_labels", words: "Orders that share one label are not fully costed. A shared label is never split between orders.",
    technical: "waiting reason shared_label", needsSignOff: false },
  { key: "staff_credits", words: "Staff wallet credits are corrections, not cash.",
    technical: `${RAIL} = 'manual' is left out of cash received`, needsSignOff: false },
  { key: "usdc", words: "USDC counts when it settles on chain, at $1.00 per USDC.",
    technical: `${RAIL} = 'usdc_base', by ${SETTLED_AT}`, needsSignOff: false },
  { key: "points_full_value", words: "Points used to pay for orders count at full value in what we billed. They are shown next to what we kept and are not taken off it.",
    technical: "rewards_spent is inside total_debit_cents; 1 point = 1¢", needsSignOff: false },
  { key: "return_credits_period", words: "Return credits Card Shellz pays count in the period they were credited.",
    technical: `type 'return_credit' by ${POSTED_AT}`, needsSignOff: false },
  { key: "dispute_cash", words: "A won dispute's cash back counts at the amount that was disputed, not at what went back into the vendor's wallet. The difference is shown under Checks.",
    technical: "cash.won_back = Σ int(paired funding_reversal metadata->>'disputeAmountCents'), not Σ funding_reinstated.amount_cents", needsSignOff: true },
].map((choice) => Object.freeze(choice)));

// ── working steps (the "How this is worked out" drawer) ──────────────────

/**
 * A working step's textKey is a line key (its words title the step) or one
 * of these, for steps that are not a line.
 */
export const FINANCE_WORKING_DEFINITIONS = Object.freeze({
  "working.two_clocks": { words: FINANCE_TWO_CLOCKS_SENTENCE,
    definition: "Which clock places each part of the working in the period." },
  "working.cogs_basis": { words: "Cost of goods is today's cost of the stock each order used, oldest stock first.",
    definition: "Why a past month's cost of goods can change." },
  "working.margin_share": { words: "Kept on orders as a share of what we billed on fully costed orders",
    definition: "The margin: both figures cover fully costed orders only." },
  "working.margin_prior": { words: "The same share for the comparison period, measured as of now",
    definition: "Both periods are measured on their fully costed orders only, so a half-finished month doesn't look worse." },
  "working.margin_change": { words: "Change in that share, in points",
    definition: "This period's share minus the comparison period's." },
  "working.not_included": { words: "Not included: packaging, Stripe's fees and overheads, which Echelon does not record. Points used are shown beside what we kept, not taken off.",
    definition: "What the working leaves out, and why." },
} satisfies Record<string, { words: string; definition: string }>);

export type FinanceWorkingKey = keyof typeof FINANCE_WORKING_DEFINITIONS;

/** The words that title a working step, from a line key or a working key; null when the key is neither. */
export function financeWorkingStepWords(textKey: string): string | null {
  if (Object.prototype.hasOwnProperty.call(FINANCE_LINE_DEFINITIONS, textKey)) {
    return FINANCE_LINE_DEFINITIONS[textKey as FinanceLineKey].words;
  }
  if (Object.prototype.hasOwnProperty.call(FINANCE_WORKING_DEFINITIONS, textKey)) {
    return FINANCE_WORKING_DEFINITIONS[textKey as FinanceWorkingKey].words;
  }
  return null;
}

// ── list sheets (part 2 opens them; titles and sources are shared now) ───

const SHEET_ONLY_METRICS = {
  "sales.paid_points": { words: "Paid with points", definition: "Accepted orders, with what each paid from its wallet and with points.",
    technicalSource: SALES_LINES["sales.billed.paid_with_points"].technicalSource },
  "pool.collected": { words: "Set aside from orders", definition: "Accepted orders, with the insurance pool share each set aside.",
    technicalSource: POOL_LINES["pool.set_aside"].technicalSource },
  "sales.no_money": { words: "Received and never charged", definition: SALES_LINES["sales.never_charged"].definition,
    technicalSource: SALES_LINES["sales.never_charged"].technicalSource },
  "cash.deposits": { words: "Deposits received", definition: CASH_LINES["cash.received_deposits"].definition,
    technicalSource: CASH_LINES["cash.received_deposits"].technicalSource },
  "cash.disputes": { words: "Disputes and bank returns", definition: "Deposit pull-backs and the disputes we won, each paired with its deposit.",
    technicalSource: CASH_LINES["cash.pulled_back"].technicalSource },
  "cash.on_the_way": { words: "On the way right now", definition: CASH_LINES["cash.memo.on_the_way"].definition,
    technicalSource: CASH_LINES["cash.memo.on_the_way"].technicalSource },
  "cash.stuck": { words: CASH_LINES["cash.memo.stuck"].words, definition: CASH_LINES["cash.memo.stuck"].definition,
    technicalSource: CASH_LINES["cash.memo.stuck"].technicalSource },
  "cash.failed": { words: "Failed deposits", definition: CASH_LINES["cash.memo.failed"].definition,
    technicalSource: CASH_LINES["cash.memo.failed"].technicalSource },
  "owed.vendors": { words: "What we owe and are owed, by wallet", definition: "One row per wallet: what we owe, what is owed to us, on the way and points held.",
    technicalSource: source([ACCOUNTS, VENDORS, LEDGER], ["available_balance_cents", "pending_balance_cents", "rewards_balance_cents"], [], null) },
  "owed.walk": { words: "How this changed", definition: "The walk from what we owed at the start to what we owe at the end, and each wallet's part of it.",
    technicalSource: OWED_LINES["owed.walk.closing"].technicalSource },
  "points.movements": { words: "Points movements", definition: "Every points entry posted in the period.",
    technicalSource: postedSource(["amount_cents"], [REWARDS_TYPES]) },
  "points.by_vendor": { words: "Points held, by vendor", definition: POINTS_LINES["points.held_now"].definition,
    technicalSource: POINTS_LINES["points.held_now"].technicalSource },
  "points.expiry": { words: "Points expiring", definition: "Points lots still holding points, by when they expire.",
    technicalSource: source([REWARDS_LOTS], ["remaining_cents", "expires_at"], ["remaining_cents > 0"], null) },
  "products.all": { words: "All products", definition: "Every product and size on the orders accepted in the period.",
    technicalSource: PRODUCT_LINES["products.billed"].technicalSource },
  "vendors.all": { words: "All vendors", definition: "Every vendor that ordered, moved money or holds a balance.",
    technicalSource: source([VENDORS, ECONOMICS, LEDGER, ACCOUNTS], ["orders, billed, kept, cash in, credits, fees, balances"], [], null) },
  "pool.replenished": { words: "Topped up", definition: POOL_LINES["pool.topped_up"].definition,
    technicalSource: POOL_LINES["pool.topped_up"].technicalSource },
  "pool.ledger": { words: "The pool's own record", definition: POOL_LINES["pool.record"].definition,
    technicalSource: POOL_LINES["pool.record"].technicalSource },
  "ledger.vendor": { words: "Wallet history", definition: "One vendor's wallet entries, with the balance after each rebuilt from settled history.",
    technicalSource: source([LEDGER], ["amount_cents", "running Σ of settled entries that move the balance, by settled_at, id"], [AVAILABLE_TYPES], SETTLED_AT) },
} satisfies Partial<Record<FinanceMetricKey, FinanceDefinition>>;

function metricDefinition(metric: FinanceMetricKey): FinanceDefinition {
  if (metric.startsWith("check.")) {
    const checkDefinition = FINANCE_CHECK_DEFINITIONS[metric.slice("check.".length) as FinanceCheckId];
    return { words: checkDefinition.wording, definition: checkDefinition.definition, technicalSource: checkDefinition.technicalSource };
  }
  if (Object.prototype.hasOwnProperty.call(SHEET_ONLY_METRICS, metric)) {
    return SHEET_ONLY_METRICS[metric as keyof typeof SHEET_ONLY_METRICS];
  }
  if (!Object.prototype.hasOwnProperty.call(FINANCE_LINE_DEFINITIONS, metric)) {
    // A metric that is neither a check, a sheet-only list nor a line has no words: fail at load, not on screen.
    throw new Error(`program finance metric ${metric} has no definition`);
  }
  const lineDefinition = FINANCE_LINE_DEFINITIONS[metric as FinanceLineKey];
  return { words: lineDefinition.words, definition: lineDefinition.definition, technicalSource: lineDefinition.technicalSource };
}

/** Every list sheet → its title, definition and technical source. */
export const FINANCE_METRIC_DEFINITIONS: Readonly<Record<FinanceMetricKey, FinanceDefinition>> = Object.freeze(
  Object.fromEntries(FINANCE_METRIC_KEYS.map((metric) => [metric, Object.freeze(metricDefinition(metric))])) as Record<FinanceMetricKey, FinanceDefinition>,
);

// ── staff ledger labels (spec §10; never the vendor-facing ones that hide the pool) ─

/** The 15 wallet entry types (shared/schema/dropship.schema.ts dropshipWalletLedgerTypeEnum; a test keeps them equal). */
export const FINANCE_LEDGER_TYPES = [
  "funding",
  "order_debit",
  "refund_credit",
  "return_credit",
  "return_fee",
  "insurance_pool_credit",
  "manual_adjustment",
  "advance_fee",
  "funding_reversal",
  "funding_reinstated",
  "rewards_earned",
  "rewards_spent",
  "rewards_reversed",
  "rewards_reinstated",
  "rewards_expired",
] as const;
export type FinanceLedgerType = (typeof FINANCE_LEDGER_TYPES)[number];

export const FINANCE_STAFF_LEDGER_LABELS: Readonly<Record<FinanceLedgerType, string>> = Object.freeze({
  funding: "Deposit · bank / card / USDC / weekly collection",
  order_debit: "Order paid from wallet",
  refund_credit: "Unexpected entry (nothing should write this)",
  return_credit: "Return credit (Card Shellz)",
  return_fee: "Return fee",
  insurance_pool_credit: "Return credit (insurance pool)",
  manual_adjustment: "Unexpected entry (nothing should write this)",
  advance_fee: "Fee for letting an order through early",
  funding_reversal: "Dispute or bank return: deposit taken back",
  funding_reinstated: "Dispute won: deposit restored",
  rewards_earned: "Points given",
  rewards_spent: "Order paid with points",
  rewards_reversed: "Points taken back",
  rewards_reinstated: "Points given back",
  rewards_expired: "Points expired",
});

/** A deposit's label by the way it was paid; a manual deposit is a staff credit. */
export const FINANCE_STAFF_DEPOSIT_LABELS = Object.freeze({
  stripe_ach: "Deposit · bank",
  stripe_card: "Deposit · card",
  usdc_base: "Deposit · USDC",
  collection: "Deposit · weekly collection",
  manual: "Staff wallet credit",
  unknown: "Deposit · way paid not recorded",
} as const);

/** Wallet entry statuses in staff words; "voided" is not in the copy deck and is shown as stored. */
export const FINANCE_STAFF_LEDGER_STATUS_WORDS = Object.freeze({
  pending: "on the way",
  settled: "settled",
  failed: "failed",
  voided: "voided",
} as const);

// ── completeness ─────────────────────────────────────────────────────────

/**
 * Keys a registry should hold but doesn't; empty when every closed list is
 * covered. The records are typed by the lists, so this guards the runtime
 * objects (a spread that lost a key) as the definitions test runs it.
 */
export function findMissingFinanceDefinitions(): string[] {
  const missing: string[] = [];
  for (const key of FINANCE_LINE_KEYS) if (!(key in FINANCE_LINE_DEFINITIONS)) missing.push(`line ${key}`);
  for (const id of FINANCE_CHECK_IDS) if (!(id in FINANCE_CHECK_DEFINITIONS)) missing.push(`check ${id}`);
  for (const key of FINANCE_INFO_KEYS) if (!(key in FINANCE_INFO_DEFINITIONS)) missing.push(`info ${key}`);
  for (const key of FINANCE_NOTE_KEYS) if (!(key in FINANCE_NOTE_DEFINITIONS)) missing.push(`note ${key}`);
  for (const key of FINANCE_DATED_BY) if (!(key in FINANCE_DATED_BY_DEFINITIONS)) missing.push(`datedBy ${key}`);
  for (const key of FINANCE_WAITING_REASONS) if (!(key in FINANCE_WAITING_REASON_DEFINITIONS)) missing.push(`waiting reason ${key}`);
  for (const key of FINANCE_SECTION_KEYS) if (!(key in FINANCE_SECTION_DEFINITIONS)) missing.push(`section ${key}`);
  for (const key of FINANCE_METRIC_KEYS) if (!(key in FINANCE_METRIC_DEFINITIONS)) missing.push(`metric ${key}`);
  return missing;
}
