import { z } from "zod";

/**
 * The Dropship "Program finance" admin page: the query
 * GET /api/dropship/admin/finance/summary accepts and the summary it returns
 * (design spec §3, server contract §1.2).
 *
 * One definition for the server, which parses its own output through
 * financeSummarySchema before sending it (a failure is a 500
 * DROPSHIP_FINANCE_CONTRACT_VIOLATION, so no unchecked number reaches the
 * page), and for the admin page, whose types are inferred from it.
 *
 * Money is signed integer cents and never a float (CLAUDE.md §4). Mills
 * (1 cent = 100 mills) travel as decimal text so a BIGINT survives JSON.
 * Every figure says what its integer means (`unit`), whether it is
 * recorded at all (`status`) and which clock places it in the period
 * (`datedBy`).
 *
 * The closed key lists at the bottom name every line the server may emit,
 * per section, in statement order. The schema refuses a line key a section
 * does not list, so a typo fails closed instead of showing a number with no
 * words. Their words, definitions and technical sources live in
 * program-finance-definitions.ts.
 *
 * Part 2 of the page (list sheets, CSV, the order record, the vendor
 * header, find) adds its schemas here; lines already carry `opensMetric`
 * for it.
 */

export const FINANCE_TIME_ZONE = "America/New_York" as const;
export const FINANCE_CONTRACT_VERSION = 1 as const;

/** Postgres int4: vendor ids are integer columns, so a larger id cannot name a vendor. */
const POSTGRES_INT4_MAX = 2_147_483_647;
/** Payload bound per section (contract §4): the summary carries no per-order arrays. */
export const FINANCE_SECTION_LINES_MAX = 60;
/** Steps in one "How this is worked out" drawer. */
export const FINANCE_WORKING_STEPS_MAX = 20;
/** Operands in one working step. */
export const FINANCE_WORKING_OPERANDS_MAX = 8;
/** Lines on one information line of the Checks area (§8). */
export const FINANCE_INFO_LINES_MAX = 6;
/** Lines one check can mark with the amber dot. */
export const FINANCE_CHECK_OWNER_LINES_MAX = 6;
/** Rows named in the Products and Vendors detail rows before "All other …". */
export const FINANCE_TOP_ROWS = 5;
/** The "of each $1" cents add up to this. */
export const FINANCE_CENTS_PER_DOLLAR = 100;
/** The bar's segment widths add up to this (layout only, never shown as a number). */
export const FINANCE_BAR_BPS_TOTAL = 10_000;
/** A deposit still on the way after this many days is stuck (check D6, cash.memo.stuck). */
export const FINANCE_STALE_PENDING_DEPOSIT_DAYS = 7;
/** An order waiting this many days for its costs needs a look (check K3). */
export const FINANCE_COST_WAIT_ALERT_DAYS = 14;
/** Group keys of the products table's aggregate rows; real rows are "v:<variantId>" or "sku:<sku>". */
export const FINANCE_PRODUCT_OTHERS_GROUP_KEY = "others" as const;
export const FINANCE_PRODUCT_TOTAL_GROUP_KEY = "total" as const;

// ── primitives ──────────────────────────────────────────────────────────

/** Signed integer cents. Never a float (CLAUDE.md §4). */
const cents = z.number().int().safe();
const count = z.number().int().nonnegative().safe();
const id = z.number().int().positive().safe();
/** Signed tenths of a percent (25.0% = 250) and basis points (25.00% = 2500). */
const tenths = z.number().int().safe();
const bps = z.number().int().safe();
/** Signed mills (1 cent = 100 mills) as decimal text so BIGINT survives JSON. */
const mills = z.string().regex(/^-?\d{1,20}$/);
/** timestamptz → ISO (precedent shared/dropship/vendor-order-detail.ts instantSchema). */
const instant = z
  .union([z.date(), z.string().datetime({ offset: true })])
  .transform((value) => (value instanceof Date ? value.toISOString() : value));
/** A calendar day in Eastern time, as YYYY-MM-DD. Whether the day exists is the server's period check. */
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** An id in a query string: digits only, no leading zero, within int4. */
const queryId = z
  .string()
  .regex(/^[1-9]\d{0,9}$/)
  .transform(Number)
  .pipe(id.max(POSTGRES_INT4_MAX));

// ── query ───────────────────────────────────────────────────────────────

export const FINANCE_PERIOD_PRESETS = ["mtd", "last-month", "last-30", "qtd", "ytd", "all", "custom"] as const;
export const financePeriodPresetSchema = z.enum(FINANCE_PERIOD_PRESETS);

const scopeShape = {
  period: financePeriodPresetSchema.default("mtd"),
  from: localDate.optional(),
  to: localDate.optional(),
  /** Forced off for "all" by the server; asking for it is not an error. */
  compare: z.enum(["on", "off"]).default("on"),
  vendorId: queryId.optional(),
};

/** `from` and `to` go with "custom" and only with it. Their order and range are the server's period check. */
function refinePeriod(query: { period: string; from?: string; to?: string }, ctx: z.RefinementCtx): void {
  const custom = query.period === "custom";
  if (custom && (!query.from || !query.to)) {
    ctx.addIssue({ code: "custom", path: ["from"], message: "custom needs from and to" });
  }
  if (!custom && (query.from || query.to)) {
    ctx.addIssue({ code: "custom", path: ["from"], message: "from/to only with custom" });
  }
}

export const financeSummaryQuerySchema = z.object(scopeShape).strict().superRefine(refinePeriod);

// ── checks and metrics ──────────────────────────────────────────────────

export const FINANCE_CHECK_IDS = [
  "W1", "W2", "W3", "W4",
  "O1", "O2", "O3", "O4", "O5", "O6",
  "D1", "D2", "D3", "D4", "D5", "D6", "D7",
  "K1", "K2", "K3",
  "R1", "R2",
  "N1", "N2", "N3",
  "P1", "P2",
] as const;
export const financeCheckIdSchema = z.enum(FINANCE_CHECK_IDS);

/**
 * Every list sheet a number can open (spec §3.6). Part 1 of the page shows
 * no links; the keys are here so lines can already say what they open.
 */
export const FINANCE_METRIC_KEYS = [
  "sales.billed", "sales.kept_orders", "sales.pool_fc", "sales.paid_points", "sales.waiting", "sales.buyer_paid", "pool.collected",
  "sales.cogs", "sales.labels", "sales.label_coverage", "sales.fees", "sales.no_money",
  "cash.deposits", "cash.disputes", "cash.on_the_way", "cash.stuck", "cash.failed",
  "returns.credits_cs", "returns.credits_pool", "returns.fees", "returns.staff_credits",
  "owed.vendors", "owed.walk", "points.movements", "points.by_vendor", "points.expiry",
  "products.all", "vendors.all", "pool.replenished", "pool.ledger", "pool.claims", "ledger.vendor",
  ...FINANCE_CHECK_IDS.map((checkId) => `check.${checkId}` as const),
] as const;
export const financeMetricKeySchema = z.enum(FINANCE_METRIC_KEYS);

// ── shared pieces ───────────────────────────────────────────────────────

export const FINANCE_UNITS = ["cents", "points", "count"] as const;
export const FINANCE_LINE_STATUSES = ["recorded", "not_recorded", "partial", "unavailable"] as const;
export const FINANCE_DATED_BY = ["accepted", "settled", "posted", "received", "now", "end_of_period"] as const;
export const FINANCE_OPERATORS = ["none", "plus", "minus", "equals"] as const;
/** Why an accepted order is not fully costed yet, in precedence order: the first that applies wins (spec §3.0). */
export const FINANCE_WAITING_REASONS = [
  "cancelled_in_oms",
  "not_shipped",
  "partly_shipped",
  "over_shipped",
  "shared_label",
  "label_missing",
  "item_cost_missing",
] as const;
/** Intakes received in the period that never moved money (contract §2.3). */
export const FINANCE_NEVER_CHARGED_KINDS = [
  "waiting_for_payment",
  "payment_time_ran_out",
  "rejected",
  "marketplace_cancelled",
  "failed",
  "exception",
] as const;

export const financeUnitSchema = z.enum(FINANCE_UNITS);
export const financeLineStatusSchema = z.enum(FINANCE_LINE_STATUSES);
export const financeDatedBySchema = z.enum(FINANCE_DATED_BY);
export const financeOperatorSchema = z.enum(FINANCE_OPERATORS);
export const financeWaitingReasonSchema = z.enum(FINANCE_WAITING_REASONS);
export const financeErrorCodeSchema = z.string().regex(/^DROPSHIP_FINANCE_[A-Z_]+$/);

/** Line keys are closed lists (below); this is only their shape: a lower-case section, then one to three parts. */
const LINE_KEY_PATTERN = /^[a-z]+(\.[a-z0-9_]+){1,3}$/;
const lineKey = z.string().regex(LINE_KEY_PATTERN);
/** Reason and working-step keys: closed lists in program-finance-definitions.ts; the contract checks the shape. */
const textKey = z.string().regex(/^[a-z0-9_.]{3,80}$/);
/** A provider's code for a failed deposit (e.g. an ACH return code), shown as stored. */
const providerCode = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);

// ── closed line keys ────────────────────────────────────────────────────

export const FINANCE_SECTION_KEYS = ["sales", "products", "cash", "returns", "owed", "points", "pool", "vendors"] as const;
export type FinanceSectionKey = (typeof FINANCE_SECTION_KEYS)[number];

/**
 * The lines each section may hold, in statement order (spec §3.4 A–H and
 * the contract §2.1–§2.9 field maps). The server leaves out a line that
 * does not apply (for example `cash.collection` when it is zero) and never
 * adds one that is not listed. Keys ending in a waiting reason or an intake
 * kind are built from those lists so the three never drift apart.
 */
export const FINANCE_SECTION_LINE_KEYS = {
  /** A. Sales and what we kept (dated by the day we accepted the order; fees and credits by the day posted). */
  sales: [
    "sales.billed",
    "sales.billed.product",
    "sales.billed.shipping",
    "sales.billed.carrier_estimate",
    "sales.billed.markup",
    "sales.billed.pool_share",
    "sales.billed.paid_from_wallets",
    "sales.billed.paid_with_points",
    "sales.waiting",
    ...FINANCE_WAITING_REASONS.map((reason) => `sales.waiting.${reason}` as const),
    "sales.billed_fc",
    "sales.cogs",
    "sales.labels",
    "sales.labels.replacement",
    "sales.pool_fc",
    "sales.packaging",
    "sales.kept_orders",
    "sales.kept_orders.on_products",
    "sales.kept_orders.on_shipping",
    "sales.fees",
    "sales.fees.advance",
    "sales.fees.card",
    "sales.fees.returns",
    "sales.return_credits_cs",
    "sales.kept",
    // "Not taken off what we kept:" memo parts.
    "sales.memo.points_used",
    "sales.memo.staff_credits",
    "sales.memo.pool_credits",
    "sales.memo.stripe_fees",
    "sales.memo.overheads",
    "sales.buyer_paid",
    "sales.never_charged",
    ...FINANCE_NEVER_CHARGED_KINDS.map((kind) => `sales.never_charged.${kind}` as const),
    "sales.never_charged.would_have_charged",
    "sales.label_coverage",
  ],
  /** B. Products sold (the table rows are `top`, `others` and `total`; these are the row's summary and footer). */
  products: [
    "products.billed",
    "products.packs",
    "products.pieces",
    "products.lines_without_pieces",
    "products.count",
    "products.packs_fully_costed",
    "products.packs_shipped",
    "products.cogs_unlinked",
  ],
  /** C. Cash in (deposits by the day they settled; everything else by the day posted). */
  cash: [
    "cash.ach",
    "cash.card",
    "cash.card.fees",
    "cash.usdc",
    "cash.usdc.chain_watcher",
    "cash.usdc.staff_confirmed",
    "cash.collection",
    "cash.unknown",
    "cash.received_deposits",
    "cash.pulled_back",
    "cash.won_back",
    "cash.received",
    "cash.memo.auto_top_ups",
    "cash.memo.auto_top_ups.minimum_balance",
    "cash.memo.auto_top_ups.payment_hold",
    "cash.memo.on_the_way",
    "cash.memo.stuck",
    "cash.memo.failed",
    "cash.memo.not_won_back",
    "cash.memo.staff_credits",
    "cash.memo.stripe_fees",
    "cash.memo.usdc_moved_out",
  ],
  /** D. Returns and credits (by the day posted). */
  returns: [
    "returns.credited",
    "returns.credits_cs",
    "returns.credits_cs.inspected",
    "returns.credits_cs.return_case",
    "returns.credits_pool",
    "returns.credits_pool.no_inspection",
    "returns.credits_pool.inspection_fault",
    "returns.credits_pool.return_case_fault",
    "returns.fees",
    "returns.fees.restocking",
    "returns.fees.processing",
    "returns.fees.return_label",
    "returns.fees.split_not_recorded",
    "returns.net",
    "returns.staff_credits",
    "returns.memo.order_refunds",
    "returns.memo.restocked_value",
    "returns.memo.return_label_cost",
  ],
  /** E. What we owe and are owed (balances right now), then the walk from the period start. */
  owed: [
    "owed.we_owe",
    "owed.they_owe",
    "owed.on_the_way",
    "owed.wallets",
    "owed.history_matches",
    "owed.walk.opening",
    "owed.walk.deposits",
    "owed.walk.staff_credits",
    "owed.walk.return_credits_cs",
    "owed.walk.return_credits_pool",
    "owed.walk.disputes_won",
    "owed.walk.orders",
    "owed.walk.advance_fees",
    "owed.walk.return_fees",
    "owed.walk.disputes_taken",
    "owed.walk.other",
    "owed.walk.unexplained",
    "owed.walk.closing",
    "owed.walk.we_owe",
    "owed.walk.they_owe",
    "owed.walk.on_the_way",
  ],
  /** F. Points (movements by the day posted; held now from the wallets). */
  points: [
    "points.opening",
    "points.given",
    "points.given.bank",
    "points.given.card",
    "points.given.usdc",
    "points.given.other",
    "points.used",
    "points.used.billed_value",
    "points.expired",
    "points.taken_back",
    "points.given_back",
    "points.held",
    "points.held_now",
    "points.memo.from_cash",
    "points.expiry.next_30_days",
    "points.expiry.days_31_to_90",
    "points.expiry.later",
    "points.expiry.never",
  ],
  /** G. Insurance pool (set aside by the day accepted; paid out and topped up by the day posted). */
  pool: [
    "pool.opening",
    "pool.set_aside",
    "pool.paid_out",
    "pool.paid_out.no_inspection",
    "pool.paid_out.inspection_fault",
    "pool.paid_out.return_case_fault",
    "pool.topped_up",
    "pool.closing",
    "pool.claims",
    "pool.record",
  ],
  /** H. Vendors (the table rows are `top`, `others` and `total`; these counts feed the row's summary and the CSV). */
  vendors: [
    "vendors.ordered",
    "vendors.wallets",
  ],
} as const satisfies Record<FinanceSectionKey, readonly string[]>;

export const FINANCE_INFO_KEYS = ["overview_bridge", "pool_record", "won_disputes"] as const;
export type FinanceInfoKey = (typeof FINANCE_INFO_KEYS)[number];

/** The lines of each information line in the Checks area (spec §8; contract §2.5, §2.8, §2.9). */
export const FINANCE_INFO_LINE_KEYS = {
  overview_bridge: [
    "info.overview_bridge.oms_row",
    "info.overview_bridge.billed",
    "info.overview_bridge.leftover_pending",
    "info.overview_bridge.cancelled_in_oms",
    "info.overview_bridge.date_basis",
  ],
  pool_record: [
    "info.pool_record.recorded",
    "info.pool_record.worked_out",
  ],
  won_disputes: [
    "info.won_disputes.cash_returned",
    "info.won_disputes.wallet_restored",
    "info.won_disputes.card_fee_part",
    "info.won_disputes.points_from_cash",
  ],
} as const satisfies Record<FinanceInfoKey, readonly string[]>;

/**
 * Figures outside the sections that a check can point at (the amber dot) or
 * a working step can cite: the answer card, the tiles and the Overview
 * bridge. Snake case, because line keys are lower case.
 */
export const FINANCE_ANCHOR_KEYS = [
  "answer.kept",
  "answer.orders",
  "answer.coverage",
  "tiles.billed",
  "tiles.cash_received",
  "tiles.we_owe_now",
  "tiles.owed_to_us_now",
  "info.overview_bridge",
] as const;

export type FinanceSectionLineKey<S extends FinanceSectionKey = FinanceSectionKey> =
  (typeof FINANCE_SECTION_LINE_KEYS)[S][number];
export type FinanceInfoLineKey<K extends FinanceInfoKey = FinanceInfoKey> = (typeof FINANCE_INFO_LINE_KEYS)[K][number];
export type FinanceAnchorKey = (typeof FINANCE_ANCHOR_KEYS)[number];
/** Every key the page has words for: section lines, information lines and anchors. */
export type FinanceLineKey = FinanceSectionLineKey | FinanceInfoLineKey | FinanceAnchorKey;

/** Every line key in one list, in page order. */
export const FINANCE_LINE_KEYS: readonly FinanceLineKey[] = Object.freeze([
  ...FINANCE_SECTION_KEYS.flatMap((section): readonly FinanceLineKey[] => FINANCE_SECTION_LINE_KEYS[section]),
  ...FINANCE_INFO_KEYS.flatMap((info): readonly FinanceLineKey[] => FINANCE_INFO_LINE_KEYS[info]),
  ...FINANCE_ANCHOR_KEYS,
]);
const ALL_LINE_KEYS: ReadonlySet<string> = new Set<string>(FINANCE_LINE_KEYS);

export function isFinanceLineKey(value: string): value is FinanceLineKey {
  return ALL_LINE_KEYS.has(value);
}

/** A key the page has words for, or the issue that says it is not. */
const knownLineKey = lineKey.refine(isFinanceLineKey, { message: "not a known finance line key" });

/**
 * Refuses keys the list does not hold, and repeated keys. `pathOf` gives the
 * issue path of the key at an index (`["lines", 3, "key"]`, `["notes", 1]`).
 */
function refineKeyList(
  keys: ReadonlyArray<string>,
  allowed: ReadonlySet<string>,
  pathOf: (index: number) => (string | number)[],
  ctx: z.RefinementCtx,
  label: string,
): void {
  const seen = new Set<string>();
  keys.forEach((key, index) => {
    if (!allowed.has(key)) ctx.addIssue({ code: "custom", path: pathOf(index), message: `not a ${label} key` });
    if (seen.has(key)) ctx.addIssue({ code: "custom", path: pathOf(index), message: `${label} key repeated` });
    seen.add(key);
  });
}

// ── lines, sections, windows ────────────────────────────────────────────

const priorSchema = z.object({
  amount: cents.nullable(),
  change: cents.nullable(),
  /** Null when the prior is zero or below: a percent of a non-positive base means nothing. */
  changeTenths: tenths.nullable(),
  changeBps: bps.nullable(),
  kind: z.enum(["change", "new", "no_change", "unavailable"]),
});

const workingStepSchema = z.object({
  step: z.number().int().min(1).max(FINANCE_WORKING_STEPS_MAX),
  /** A line key or a working key (program-finance-definitions.ts) whose words title the step. */
  textKey,
  operands: z
    .array(z.object({ lineKey: knownLineKey, amount: cents.nullable(), unit: financeUnitSchema, operator: financeOperatorSchema }))
    .max(FINANCE_WORKING_OPERANDS_MAX),
  result: cents.nullable(),
  opensMetric: financeMetricKeySchema.optional(),
});

const coverageSchema = z
  .object({ done: count, total: count })
  .refine((coverage) => coverage.done <= coverage.total, { message: "coverage done exceeds total" });

/**
 * A figure's status decides whether it may carry a number. A recorded figure
 * always has one. "Not recorded" and "unavailable" never do, so a missing
 * value can never be read as $0.00.
 */
function refineAmountForStatus(
  figure: { status: string; amount: number | null },
  ctx: z.RefinementCtx,
): void {
  if (figure.status === "recorded" && figure.amount === null) {
    ctx.addIssue({ code: "custom", path: ["amount"], message: "recorded line needs an amount" });
  }
  if (figure.status === "not_recorded" && figure.amount !== null) {
    ctx.addIssue({ code: "custom", path: ["amount"], message: "not recorded is never a number" });
  }
  if (figure.status === "unavailable" && figure.amount !== null) {
    ctx.addIssue({ code: "custom", path: ["amount"], message: "unavailable is never a number" });
  }
}

export const financeLineSchema = z
  .object({
    key: lineKey,
    /** The UI shows the amount unsigned on operator lines; the operator carries the direction. */
    operator: financeOperatorSchema,
    /** The integer means what `unit` says (contract C3). */
    amount: cents.nullable(),
    unit: financeUnitSchema,
    status: financeLineStatusSchema,
    /** Why the line is not recorded, partial or unavailable (program-finance-definitions.ts reasons). */
    reasonKey: textKey.optional(),
    errorCode: financeErrorCodeSchema.optional(),
    count: count.optional(),
    coverage: coverageSchema.optional(),
    datedBy: financeDatedBySchema,
    prior: priorSchema.optional(),
    percentTenths: tenths.nullable().optional(),
    percentBps: bps.nullable().optional(),
    /** "every_line" lines are hidden when zero in Summary depth. */
    depth: z.enum(["summary", "every_line"]),
    opensMetric: financeMetricKeySchema.optional(),
    /** The first failed deposit's provider code; only on `cash.memo.failed`. */
    failureCode: providerCode.optional(),
    workings: z.array(workingStepSchema).max(FINANCE_WORKING_STEPS_MAX).optional(),
  })
  .superRefine((line, ctx) => {
    refineAmountForStatus(line, ctx);
    if ((line.status === "not_recorded" || line.status === "partial") && line.reasonKey === undefined) {
      ctx.addIssue({ code: "custom", path: ["reasonKey"], message: `a ${line.status} line says why` });
    }
    if (line.status === "unavailable" && line.reasonKey === undefined && line.errorCode === undefined) {
      ctx.addIssue({ code: "custom", path: ["errorCode"], message: "an unavailable line says why" });
    }
  });

const sectionStatusSchema = z.enum(["ok", "error", "skipped"]);
const sectionShape = {
  status: sectionStatusSchema,
  errorCode: financeErrorCodeSchema.optional(),
  lines: z.array(financeLineSchema).max(FINANCE_SECTION_LINES_MAX),
};

/**
 * A section holds only its own line keys, each once. A section that failed
 * or was skipped names its error code and shows no numbers at all, so a
 * half-built section can never sit under its title.
 */
function refineSection(section: FinanceSectionKey) {
  const allowed: ReadonlySet<string> = new Set<string>(FINANCE_SECTION_LINE_KEYS[section]);
  return (
    value: { status: string; errorCode?: string; lines: ReadonlyArray<{ key: string }> },
    ctx: z.RefinementCtx,
  ): void => {
    refineKeyList(value.lines.map((line) => line.key), allowed, (index) => ["lines", index, "key"], ctx, `${section} line`);
    if (value.status !== "ok") {
      if (value.errorCode === undefined) {
        ctx.addIssue({ code: "custom", path: ["errorCode"], message: "a failed or skipped section names its error code" });
      }
      if (value.lines.length > 0) {
        ctx.addIssue({ code: "custom", path: ["lines"], message: "a failed or skipped section shows no lines" });
      }
    }
  };
}

function sectionSchemaFor(section: FinanceSectionKey) {
  return z.object(sectionShape).superRefine(refineSection(section));
}

const windowSchema = z.object({
  preset: financePeriodPresetSchema,
  /** The Eastern calendar day the window starts; null for all time. */
  fromDate: localDate.nullable(),
  /** The last Eastern calendar day shown. */
  toDate: localDate,
  startAt: instant.nullable(),
  /** generatedAt when the window ends now. */
  endAt: instant,
  endsNow: z.boolean(),
  /** Compare window only: the month had fewer days ("Feb has 28 days"). */
  clampedToMonthEnd: z.boolean(),
});

const figureShape = {
  amount: cents.nullable(),
  status: financeLineStatusSchema,
  errorCode: financeErrorCodeSchema.optional(),
};
const figureSchema = z.object(figureShape).superRefine(refineAmountForStatus);

const vendorNameSchema = z.object({
  vendorId: id,
  name: z.string().max(200),
  nameSource: z.enum(["business_name", "contact_name", "id"]),
});

// ── summary tables (spec §3.4 B and H) ──────────────────────────────────

export const financeProductRowSchema = z.object({
  /** "v:<variantId>" | "sku:<sku>"; FINANCE_PRODUCT_OTHERS_GROUP_KEY / FINANCE_PRODUCT_TOTAL_GROUP_KEY on aggregate rows. */
  groupKey: z.string().max(140),
  productVariantId: id.nullable(),
  productId: id.nullable(),
  productName: z.string().nullable(),
  sizeName: z.string().nullable(),
  sku: z.string().nullable(),
  unitsPerVariant: count.nullable(),
  packs: count,
  pieces: count.nullable(),
  linesWithoutPieces: count,
  packsShipped: count,
  packsFullyCosted: count,
  billedForProduct: cents,
  billedOnFullyCosted: cents,
  costOfGoods: cents,
  costOfGoodsMills: mills,
  keptOnProduct: cents,
  keptTenths: tenths.nullable(),
});

/** One vendor's figures, the same columns on a named row and on the aggregate rows. */
const vendorFiguresShape = {
  orders: count,
  billed: cents,
  waitingOnCosts: count,
  keptOnOrders: cents,
  feesCharged: cents,
  returnCreditsPaid: cents,
  kept: cents,
  cashIn: cents,
  creditsToVendor: cents,
  weOweNow: cents,
  theyOweNow: cents,
  onTheWay: cents,
  pointsHeld: count,
};

export const financeVendorRowSchema = vendorNameSchema.extend({
  status: z.string().max(30),
  ...vendorFiguresShape,
});

/**
 * "All other vendors" and the totals row. They belong to no single vendor,
 * so they carry how many vendors they add up instead of a vendor id.
 */
export const financeVendorAggregateRowSchema = z.object({
  vendors: count,
  ...vendorFiguresShape,
});

// ── checks ──────────────────────────────────────────────────────────────

export const FINANCE_CHECK_GROUPS = ["wallets", "orders", "deposits", "costs", "returns_pool", "never", "page"] as const;
export const FINANCE_CHECK_RESULTS = ["fine", "needs_a_look", "could_not_check", "program_wide"] as const;
export const FINANCE_CHECK_SCOPES = ["period", "now", "all_time"] as const;

export const financeCheckSchema = z.object({
  id: financeCheckIdSchema,
  group: z.enum(FINANCE_CHECK_GROUPS),
  result: z.enum(FINANCE_CHECK_RESULTS),
  scope: z.enum(FINANCE_CHECK_SCOPES),
  examined: count,
  exceptions: count,
  /** Σ|found − expected| over the exceptions, when the check is about money. */
  difference: cents.nullable(),
  errorCode: financeErrorCodeSchema.optional(),
  /** Where the UI puts the amber dot. */
  ownerLineKeys: z.array(knownLineKey).max(FINANCE_CHECK_OWNER_LINES_MAX),
});

// ── summary (spec §3.1–§3.4, §7, §8) ────────────────────────────────────

const sectionsSchema = z.object({
  sales: sectionSchemaFor("sales"),
  cash: sectionSchemaFor("cash"),
  returns: sectionSchemaFor("returns"),
  owed: sectionSchemaFor("owed"),
  points: sectionSchemaFor("points"),
  pool: sectionSchemaFor("pool"),
  products: z
    .object({
      ...sectionShape,
      top: z.array(financeProductRowSchema).max(FINANCE_TOP_ROWS),
      others: financeProductRowSchema.nullable(),
      total: financeProductRowSchema.nullable(),
      roundingCents: z.object({ costOfGoods: cents, keptOnProduct: cents }),
    })
    .superRefine(refineSection("products"))
    .superRefine(refineTableRowsForStatus),
  vendors: z
    .object({
      ...sectionShape,
      top: z.array(financeVendorRowSchema).max(FINANCE_TOP_ROWS),
      others: financeVendorAggregateRowSchema.nullable(),
      total: financeVendorAggregateRowSchema.nullable(),
      roundingCents: z.object({ keptOnOrders: cents, kept: cents }),
      vendorsOrdered: count,
      wallets: count,
    })
    .superRefine(refineSection("vendors"))
    .superRefine(refineTableRowsForStatus),
});

/** A table section that failed or was skipped shows no rows either. */
function refineTableRowsForStatus(
  value: { status: string; top: ReadonlyArray<unknown>; others: unknown; total: unknown },
  ctx: z.RefinementCtx,
): void {
  if (value.status !== "ok" && (value.top.length > 0 || value.others !== null || value.total !== null)) {
    ctx.addIssue({ code: "custom", path: ["top"], message: "a failed or skipped section shows no rows" });
  }
}

const splitOfEachDollarSchema = z
  .object({ kept: count, costOfGoods: count, carrierLabels: count, poolShare: count })
  .refine(
    (split) => split.kept + split.costOfGoods + split.carrierLabels + split.poolShare === FINANCE_CENTS_PER_DOLLAR,
    { message: "the cents of each dollar add up to 100" },
  );

const barBpsSchema = z
  .object({ kept: count, costOfGoods: count, carrierLabels: count, poolShare: count, waiting: count })
  .refine(
    (bar) => bar.kept + bar.costOfGoods + bar.carrierLabels + bar.poolShare + bar.waiting === FINANCE_BAR_BPS_TOTAL,
    { message: "the bar widths add up to 10000" },
  );

const answerSchema = z
  .object({
    state: z.enum(["kept", "loss", "no_orders", "not_ready", "unavailable"]),
    status: sectionStatusSchema,
    errorCode: financeErrorCodeSchema.optional(),
    /** KO + FE − RC, the hero figure. */
    kept: figureSchema,
    keptOnOrders: cents.nullable(),
    feesCharged: cents.nullable(),
    returnCreditsPaid: cents.nullable(),
    orders: count,
    billed: cents,
    fullyCosted: z.object({ orders: count, billed: cents }),
    waiting: z.object({ orders: count, billed: cents }),
    costOfGoods: cents.nullable(),
    carrierLabels: cents.nullable(),
    poolShare: cents.nullable(),
    marginTenths: tenths.nullable(),
    marginBps: bps.nullable(),
    priorMarginTenths: tenths.nullable(),
    marginChangeTenths: tenths.nullable(),
    centsOfEachDollar: splitOfEachDollarSchema.nullable(),
    barBps: barBpsSchema.nullable(),
    /** 1 point = 1¢ off an order, so the two integers are equal (CD 8). */
    paidWithPoints: z.object({ billed: cents, points: count }),
    coverage: coverageSchema,
    workings: z.array(workingStepSchema).max(FINANCE_WORKING_STEPS_MAX),
  })
  .superRefine((answer, ctx) => {
    const failed = answer.status !== "ok";
    if (failed !== (answer.state === "unavailable")) {
      ctx.addIssue({ code: "custom", path: ["state"], message: "the answer is unavailable exactly when its section failed" });
    }
    if (failed && answer.errorCode === undefined) {
      ctx.addIssue({ code: "custom", path: ["errorCode"], message: "a failed answer names its error code" });
    }
  });

const tilesSchema = z.object({
  billed: z
    .object({ ...figureShape, orders: count, prior: priorSchema.nullable() })
    .superRefine(refineAmountForStatus),
  cashReceived: z
    .object({ ...figureShape, prior: priorSchema.nullable() })
    .superRefine(refineAmountForStatus),
  weOweNow: z
    .object({ ...figureShape, vendors: count, onTheWay: cents.nullable(), atEndOfPeriod: cents.nullable() })
    .superRefine(refineAmountForStatus),
  owedToUsNow: z
    .object({ ...figureShape, vendors: count, atEndOfPeriod: cents.nullable() })
    .superRefine(refineAmountForStatus),
});

const infoLineSchema = z.object({
  key: z.enum(FINANCE_INFO_KEYS),
  status: financeLineStatusSchema,
  lines: z.array(financeLineSchema).max(FINANCE_INFO_LINES_MAX),
});

export const FINANCE_NOTE_KEYS = ["card_fee_era", "pricing_v1_era", "weekly_collection_era"] as const;
export type FinanceNoteKey = (typeof FINANCE_NOTE_KEYS)[number];

const CHECK_ID_SET: ReadonlySet<string> = new Set<string>(FINANCE_CHECK_IDS);
const INFO_KEY_SET: ReadonlySet<string> = new Set<string>(FINANCE_INFO_KEYS);
const NOTE_KEY_SET: ReadonlySet<string> = new Set<string>(FINANCE_NOTE_KEYS);

export const financeSummarySchema = z
  .object({
    contractVersion: z.literal(FINANCE_CONTRACT_VERSION),
    generatedAt: instant,
    timeZone: z.literal(FINANCE_TIME_ZONE),
    scope: z.object({ vendor: vendorNameSchema.nullable() }),
    /** §3.1, §5 */
    period: windowSchema,
    /** §3.1 Compare switch; null for all time or compare=off. */
    comparePeriod: windowSchema.nullable(),
    /** §3.2 answer card */
    answer: answerSchema,
    /** §3.3 */
    tiles: tilesSchema,
    /** §3.4 A–H */
    sections: sectionsSchema,
    /** §3.4 I, §8: every check, once. */
    checks: z.array(financeCheckSchema).length(FINANCE_CHECK_IDS.length),
    /** §8 information lines */
    info: z.array(infoLineSchema).max(FINANCE_INFO_KEYS.length),
    /** §7 policy-era notes */
    notes: z.array(z.enum(FINANCE_NOTE_KEYS)).max(FINANCE_NOTE_KEYS.length),
  })
  .superRefine((summary, ctx) => {
    // Exactly 27 entries and no repeat means every check is reported once.
    refineKeyList(summary.checks.map((check) => check.id), CHECK_ID_SET, (index) => ["checks", index, "id"], ctx, "check");
    refineKeyList(summary.info.map((info) => info.key), INFO_KEY_SET, (index) => ["info", index, "key"], ctx, "info");
    summary.info.forEach((info, infoIndex) => {
      refineKeyList(
        info.lines.map((line) => line.key),
        new Set<string>(FINANCE_INFO_LINE_KEYS[info.key]),
        (index) => ["info", infoIndex, "lines", index, "key"],
        ctx,
        `${info.key} line`,
      );
    });
    refineKeyList(summary.notes, NOTE_KEY_SET, (index) => ["notes", index], ctx, "note");
    if (summary.period.preset === "all" && summary.comparePeriod !== null) {
      ctx.addIssue({ code: "custom", path: ["comparePeriod"], message: "all time has nothing earlier to compare with" });
    }
  });

// ── errors (spec §7, contract §5) ───────────────────────────────────────

export const financeErrorEnvelopeSchema = z.object({
  error: z.object({
    code: financeErrorCodeSchema,
    message: z.string(),
    context: z.object({ classification: z.enum(["transient", "permanent", "fatal"]) }).passthrough(),
  }),
});

// ── types ───────────────────────────────────────────────────────────────

export type FinancePeriodPreset = z.infer<typeof financePeriodPresetSchema>;
export type FinanceSummaryQuery = z.infer<typeof financeSummaryQuerySchema>;
export type FinanceCheckId = (typeof FINANCE_CHECK_IDS)[number];
export type FinanceMetricKey = (typeof FINANCE_METRIC_KEYS)[number];
export type FinanceUnit = (typeof FINANCE_UNITS)[number];
export type FinanceLineStatus = (typeof FINANCE_LINE_STATUSES)[number];
export type FinanceDatedBy = (typeof FINANCE_DATED_BY)[number];
export type FinanceOperator = (typeof FINANCE_OPERATORS)[number];
export type FinanceWaitingReason = (typeof FINANCE_WAITING_REASONS)[number];
export type FinanceNeverChargedKind = (typeof FINANCE_NEVER_CHARGED_KINDS)[number];
export type FinanceCheckGroup = (typeof FINANCE_CHECK_GROUPS)[number];
export type FinanceCheckResult = (typeof FINANCE_CHECK_RESULTS)[number];
export type FinanceCheckScope = (typeof FINANCE_CHECK_SCOPES)[number];
export type FinanceSectionStatus = z.infer<typeof sectionStatusSchema>;

export type FinancePrior = z.infer<typeof priorSchema>;
export type FinanceWorkingStep = z.infer<typeof workingStepSchema>;
export type FinanceLine = z.infer<typeof financeLineSchema>;
export type FinanceSection = z.infer<typeof sectionsSchema>["sales"];
export type FinanceWindow = z.infer<typeof windowSchema>;
export type FinanceFigure = z.infer<typeof figureSchema>;
export type FinanceVendorName = z.infer<typeof vendorNameSchema>;
export type FinanceProductRow = z.infer<typeof financeProductRowSchema>;
export type FinanceVendorRow = z.infer<typeof financeVendorRowSchema>;
export type FinanceVendorAggregateRow = z.infer<typeof financeVendorAggregateRowSchema>;
export type FinanceCheck = z.infer<typeof financeCheckSchema>;
export type FinanceInfoLine = z.infer<typeof infoLineSchema>;
export type FinanceAnswer = z.infer<typeof answerSchema>;
export type FinanceTiles = z.infer<typeof tilesSchema>;
export type FinanceSections = z.infer<typeof sectionsSchema>;
/** What the page receives (instants as ISO text). */
export type FinanceSummary = z.infer<typeof financeSummarySchema>;
/** What the server may hand to financeSummarySchema (instants may still be Dates). */
export type FinanceSummaryInput = z.input<typeof financeSummarySchema>;
export type FinanceErrorEnvelope = z.infer<typeof financeErrorEnvelopeSchema>;
