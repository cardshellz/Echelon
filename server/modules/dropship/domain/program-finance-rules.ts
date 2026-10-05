/**
 * Pure rules of the Dropship "Program finance" page (contract §2.10, §3):
 * the waiting-reason precedence (the TS mirror of the SQL `classified` CTE),
 * changes against the comparison window, shares, the two largest-remainder
 * splits of the answer card, vendor display names, the policy-era notes and
 * the page's own identities (check P1).
 *
 * Integer arithmetic only (BigInt, shared/dropship/program-finance-money.ts);
 * no clock, no I/O. Nothing here rounds money except signedMillsToCents,
 * once per displayed total, in the caller.
 */

import {
  FINANCE_BAR_BPS_TOTAL,
  FINANCE_CENTS_PER_DOLLAR,
  FINANCE_NOTE_KEYS,
  FINANCE_WAITING_REASONS,
  type FinanceAnswer,
  type FinanceLine,
  type FinanceNoteKey,
  type FinancePrior,
  type FinanceSectionLineKey,
  type FinanceSections,
  type FinanceTiles,
  type FinanceUnit,
  type FinanceVendorName,
  type FinanceWaitingReason,
} from "../../../../shared/dropship/program-finance";
import { FINANCE_NOTE_DEFINITIONS } from "../../../../shared/dropship/program-finance-definitions";
import {
  largestRemainder,
  toBps,
  toSafeNumber,
  toTenths,
} from "../../../../shared/dropship/program-finance-money";

const ZERO = BigInt(0);

// ── waiting reasons (spec §3.0) ─────────────────────────────────────────

/** One order's costing facts, as the SQL `facts` CTE computes them. */
export interface FinanceOrderCostingFacts {
  /** OMS order cancelled_at set or status 'cancelled'. */
  readonly omsCancelled: boolean;
  /** Packs shipped to the customer on shipped, returned or lost packages. */
  readonly shippedPacks: bigint;
  /** Σ oms_order_lines.quantity */
  readonly orderedPacks: bigint;
  /** Any package of the order on a combined label or a label another order also carries. */
  readonly anyShared: boolean;
  /** Distinct labels on the order's packages, and how many have a recorded cost. */
  readonly labels: bigint;
  readonly labelsCosted: bigint;
  /** OMS lines whose net costed packs differ from their packs. */
  readonly linesCostMismatch: bigint;
}

/**
 * Why an order is not fully costed yet, or null when it is. The first
 * reason that applies wins, in the order of FINANCE_WAITING_REASONS: the
 * same CASE as the contract's `classified` CTE (the integration test checks
 * that SQL and this agree for every seeded order).
 */
export function classifyWaitingReason(facts: FinanceOrderCostingFacts): FinanceWaitingReason | null {
  if (facts.omsCancelled) return "cancelled_in_oms";
  if (facts.shippedPacks === ZERO) return "not_shipped";
  if (facts.shippedPacks < facts.orderedPacks) return "partly_shipped";
  if (facts.shippedPacks > facts.orderedPacks) return "over_shipped";
  if (facts.anyShared) return "shared_label";
  if (facts.labelsCosted < facts.labels) return "label_missing";
  if (facts.linesCostMismatch > ZERO) return "item_cost_missing";
  return null;
}

// ── shares and changes ──────────────────────────────────────────────────

export interface FinanceShare {
  /** Signed tenths of a percent (39.9% = 399). */
  readonly tenths: bigint | null;
  /** Signed basis points (39.89% = 3989), from the same integers. */
  readonly bps: bigint | null;
}

/**
 * numerator as a share of denominator; both null when the denominator is
 * zero or below, because a share of nothing (or of a negative base) means
 * nothing and is never shown as 0%.
 */
export function financeShare(numerator: bigint, denominator: bigint): FinanceShare {
  if (denominator <= ZERO) return { tenths: null, bps: null };
  return { tenths: toTenths(numerator, denominator), bps: toBps(numerator, denominator) };
}

/**
 * What the comparison window gives for a figure: null when there is none
 * (Compare off, all time), "unavailable" when its statement failed, or its
 * value.
 */
export type FinanceCompareValue = bigint | "unavailable" | null;

const UNAVAILABLE_PRIOR: FinancePrior = Object.freeze({
  amount: null,
  change: null,
  changeTenths: null,
  changeBps: null,
  kind: "unavailable",
});

/**
 * The change line under a figure (spec §3.3, contract §2.10). Null when
 * there is no comparison. Prior 0 and current above 0 is "new"; no
 * difference is "no change" (both 0, or equal); otherwise "change", with a
 * percent only when the prior is above 0. A current or prior that failed,
 * or a number a JSON number can't carry exactly, is "unavailable".
 */
export function buildFinancePrior(current: bigint | null, prior: FinanceCompareValue): FinancePrior | null {
  if (prior === null) return null;
  if (prior === "unavailable" || current === null) {
    const amount = prior === "unavailable" ? null : toSafeNumber(prior);
    return { ...UNAVAILABLE_PRIOR, amount };
  }
  const change = current - prior;
  const share = financeShare(change, prior);
  const amount = toSafeNumber(prior);
  const changeNumber = toSafeNumber(change);
  if (amount === null || changeNumber === null) return UNAVAILABLE_PRIOR;
  const kind = prior === ZERO && current > ZERO ? "new" : change === ZERO ? "no_change" : "change";
  return {
    amount,
    change: changeNumber,
    changeTenths: share.tenths === null ? null : toSafeNumber(share.tenths),
    changeBps: share.bps === null ? null : toSafeNumber(share.bps),
    kind,
  };
}

// ── the answer card's two splits (spec §3.2) ────────────────────────────

export interface FinanceBilledParts {
  readonly kept: bigint;
  readonly costOfGoods: bigint;
  readonly carrierLabels: bigint;
  readonly poolShare: bigint;
}

/**
 * "Of each $1": the four parts of what we billed on fully costed orders in
 * whole cents adding up to exactly 100, by largest remainder with ties in
 * the order kept, cost of goods, labels, pool. Null when there is nothing
 * to split, a part is negative (a loss is not a share), or the parts do not
 * add up to the base (check P1 reports that).
 */
export function centsOfEachDollar(parts: FinanceBilledParts, billedFullyCosted: bigint): FinanceBilledParts | null {
  const split = largestRemainder(
    [parts.kept, parts.costOfGoods, parts.carrierLabels, parts.poolShare],
    billedFullyCosted,
    BigInt(FINANCE_CENTS_PER_DOLLAR),
  );
  if (!split) return null;
  return { kept: split[0], costOfGoods: split[1], carrierLabels: split[2], poolShare: split[3] };
}

export interface FinanceBarParts extends FinanceBilledParts {
  /** Billed on orders not fully costed yet. */
  readonly waiting: bigint;
}

/** The bar's segment widths in basis points of all billing, adding up to 10000 (layout only); null as above. */
export function barWidths(parts: FinanceBarParts, billed: bigint): FinanceBarParts | null {
  const split = largestRemainder(
    [parts.kept, parts.costOfGoods, parts.carrierLabels, parts.poolShare, parts.waiting],
    billed,
    BigInt(FINANCE_BAR_BPS_TOTAL),
  );
  if (!split) return null;
  return { kept: split[0], costOfGoods: split[1], carrierLabels: split[2], poolShare: split[3], waiting: split[4] };
}

// ── vendor names ────────────────────────────────────────────────────────

/** The contract's bound on a vendor name. */
export const FINANCE_VENDOR_NAME_MAX = 200;
const ELLIPSIS = "…";

function boundedName(name: string): string {
  if (name.length <= FINANCE_VENDOR_NAME_MAX) return name;
  let cut = FINANCE_VENDOR_NAME_MAX - ELLIPSIS.length;
  // Never split a surrogate pair: the schema counts UTF-16 units.
  const lastKept = name.charCodeAt(cut - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) cut -= 1;
  return `${name.slice(0, cut)}${ELLIPSIS}`;
}

/** business_name, else contact_name, else "Vendor #id" (contract §2.10); blank names fall through. */
export function financeVendorName(vendorId: number, businessName: string | null, contactName: string | null): FinanceVendorName {
  const business = businessName?.trim() ?? "";
  if (business.length > 0) return { vendorId, name: boundedName(business), nameSource: "business_name" };
  const contact = contactName?.trim() ?? "";
  if (contact.length > 0) return { vendorId, name: boundedName(contact), nameSource: "contact_name" };
  return { vendorId, name: `Vendor #${vendorId}`, nameSource: "id" };
}

// ── policy-era notes (spec §7) ──────────────────────────────────────────

/**
 * The notes whose era overlaps the window's Eastern days. Era dates are
 * inclusive Eastern days (FINANCE_NOTE_DEFINITIONS); YYYY-MM-DD text
 * compares in calendar order. An open end (null) never limits the overlap.
 */
export function financePolicyEraNotes(window: { readonly fromDate: string | null; readonly toDate: string }): FinanceNoteKey[] {
  return FINANCE_NOTE_KEYS.filter((key) => {
    const { firstDate, lastDate } = FINANCE_NOTE_DEFINITIONS[key];
    const windowStartsBeforeEraEnds = lastDate === null || window.fromDate === null || window.fromDate <= lastDate;
    const windowEndsAfterEraStarts = firstDate === null || window.toDate >= firstDate;
    return windowStartsBeforeEraEnds && windowEndsAfterEraStarts;
  });
}

// ── check P1: the page's own identities (contract §3) ───────────────────

/** One identity evaluated over the summary. */
export interface FinanceIdentityItem {
  /** "identity_<n>_<what>" (contract §3 P1 numbering). */
  readonly detailKey: string;
  readonly unit: FinanceUnit;
  readonly expected: bigint;
  readonly found: bigint;
}

export interface FinanceIdentityReport {
  /** Every identity whose figures were all on the page. */
  readonly examined: readonly FinanceIdentityItem[];
  /** The ones that do not hold. */
  readonly exceptions: readonly FinanceIdentityItem[];
}

/** What the identities read: the summary's figures (numbers as the contract carries them). */
export interface FinanceIdentityInput {
  readonly answer: FinanceAnswer;
  readonly tiles: FinanceTiles;
  readonly sections: FinanceSections;
  /** Held now must equal the points walk only when the period ends now. */
  readonly endsNow: boolean;
}

/** A line's amount with the direction its operator gives it ("minus $5" is −5). */
export function financeLineEffect(line: Pick<FinanceLine, "operator" | "amount">): bigint | null {
  if (line.amount === null) return null;
  const amount = BigInt(line.amount);
  return line.operator === "minus" ? -amount : amount;
}

/**
 * A line's signed quantity: its effect read back against the operator the
 * statement normally gives it, so a "minus" line flipped to "plus" (a
 * negative cost) reads as the negative number it is.
 */
function quantityOf(line: FinanceLine, usualOperator: "plus" | "minus" | "none"): bigint | null {
  const effect = financeLineEffect(line);
  if (effect === null) return null;
  return usualOperator === "minus" ? -effect : effect;
}

/**
 * The lines of one section, looked up by key. A line that is absent counts
 * as 0 where the statement leaves zero parts out (`part`), and makes the
 * identity unexaminable where it must be there (`required`). A line that is
 * there but has no number (not recorded, unavailable) always makes the
 * identity unexaminable.
 */
class SectionLines {
  private readonly byKey: ReadonlyMap<string, FinanceLine>;
  readonly ok: boolean;

  constructor(section: { status: string; lines: readonly FinanceLine[] }) {
    this.ok = section.status === "ok";
    this.byKey = new Map(section.lines.map((line) => [line.key, line]));
  }

  line(key: string): FinanceLine | undefined {
    return this.byKey.get(key);
  }

  required(key: string, usual: "plus" | "minus" | "none" = "none", allowPartial = true): bigint | undefined {
    const line = this.byKey.get(key);
    if (!this.ok || !line) return undefined;
    if (line.status === "not_recorded" || line.status === "unavailable") return undefined;
    if (!allowPartial && line.status === "partial") return undefined;
    return quantityOf(line, usual) ?? undefined;
  }

  part(key: string, usual: "plus" | "minus" | "none" = "none"): bigint | undefined {
    if (!this.ok) return undefined;
    if (!this.byKey.has(key)) return ZERO;
    return this.required(key, usual);
  }

  count(key: string): bigint | undefined {
    const line = this.byKey.get(key);
    if (!this.ok || !line || line.count === undefined) return undefined;
    return BigInt(line.count);
  }
}

class IdentityCollector {
  readonly examined: FinanceIdentityItem[] = [];

  add(detailKey: string, unit: FinanceUnit, expected: bigint | null | undefined, found: ReadonlyArray<bigint | null | undefined>): void {
    if (expected === null || expected === undefined) return;
    let sum = ZERO;
    for (const value of found) {
      if (value === null || value === undefined) return;
      sum += value;
    }
    this.examined.push({ detailKey, unit, expected, found: sum });
  }
}

function sumOf(values: ReadonlyArray<number>): bigint {
  return values.reduce((total, value) => total + BigInt(value), ZERO);
}

function numberOrNull(value: number | null | undefined): bigint | null {
  return value === null || value === undefined ? null : BigInt(value);
}

const DEPOSIT_RAIL_KEYS: readonly FinanceSectionLineKey<"cash">[] = ["cash.ach", "cash.card", "cash.usdc", "cash.collection", "cash.unknown"];
const POINTS_GIVEN_PARTS: readonly FinanceSectionLineKey<"points">[] = ["points.given.bank", "points.given.card", "points.given.usdc", "points.given.other"];
const POOL_PAID_PARTS: readonly FinanceSectionLineKey<"pool">[] = [
  "pool.paid_out.no_inspection",
  "pool.paid_out.inspection_fault",
  "pool.paid_out.return_case_fault",
];
const OWED_WALK_MOVEMENTS: readonly { key: FinanceSectionLineKey<"owed">; usual: "plus" | "minus" | "none" }[] = [
  { key: "owed.walk.deposits", usual: "plus" },
  { key: "owed.walk.staff_credits", usual: "plus" },
  { key: "owed.walk.return_credits_cs", usual: "plus" },
  { key: "owed.walk.return_credits_pool", usual: "plus" },
  { key: "owed.walk.disputes_won", usual: "plus" },
  { key: "owed.walk.orders", usual: "minus" },
  { key: "owed.walk.advance_fees", usual: "minus" },
  { key: "owed.walk.return_fees", usual: "minus" },
  { key: "owed.walk.disputes_taken", usual: "minus" },
  { key: "owed.walk.other", usual: "plus" },
  { key: "owed.walk.unexplained", usual: "plus" },
];

function salesIdentities(collect: IdentityCollector, answer: FinanceAnswer, sales: SectionLines): void {
  // 1. The bar adds up to billed, and the Sales statement closes.
  if (answer.status === "ok") {
    collect.add("identity_1_bar", "cents", BigInt(answer.billed), [
      numberOrNull(answer.keptOnOrders),
      numberOrNull(answer.costOfGoods),
      numberOrNull(answer.carrierLabels),
      numberOrNull(answer.poolShare),
      BigInt(answer.waiting.billed),
    ]);
  }
  collect.add("identity_1_sales_fully_costed", "cents", sales.required("sales.billed_fc"), [
    sales.required("sales.billed"),
    negate(sales.required("sales.waiting", "minus")),
  ]);
  collect.add("identity_1_sales_kept_on_orders", "cents", sales.required("sales.kept_orders"), [
    sales.required("sales.billed_fc"),
    negate(sales.required("sales.cogs", "minus")),
    negate(sales.required("sales.labels", "minus")),
    negate(sales.required("sales.pool_fc", "minus")),
  ]);
  collect.add("identity_1_sales_kept", "cents", sales.required("sales.kept"), [
    sales.required("sales.kept_orders"),
    sales.required("sales.fees", "plus"),
    negate(sales.required("sales.return_credits_cs", "minus")),
  ]);

  // 2. Product + shipping = billed; carrier estimate + markup + pool share = shipping (packaging is 0, check O3).
  collect.add("identity_2_billed_parts", "cents", sales.required("sales.billed"), [
    sales.required("sales.billed.product"),
    sales.required("sales.billed.shipping"),
  ]);
  collect.add("identity_2_shipping_parts", "cents", sales.required("sales.billed.shipping"), [
    sales.required("sales.billed.carrier_estimate", "none", false),
    sales.required("sales.billed.markup", "none", false),
    sales.required("sales.billed.pool_share"),
  ]);

  // 3. Paid from wallets + paid with points = billed.
  collect.add("identity_3_paid", "cents", sales.required("sales.billed"), [
    sales.required("sales.billed.paid_from_wallets"),
    sales.required("sales.billed.paid_with_points"),
  ]);

  // 4. The waiting reasons add up to the waiting line, in dollars and orders.
  const reasonKeys = FINANCE_WAITING_REASONS.map((reason) => `sales.waiting.${reason}` as const);
  collect.add("identity_4_waiting_billed", "cents", sales.required("sales.waiting", "minus"), reasonKeys.map((key) => sales.part(key)));
  collect.add("identity_4_waiting_orders", "count", sales.count("sales.waiting"), reasonKeys.map((key) =>
    sales.line(key) ? sales.count(key) : ZERO));

  // 5. Kept on products + kept on shipping = kept on orders.
  collect.add("identity_5_kept_parts", "cents", sales.required("sales.kept_orders"), [
    sales.required("sales.kept_orders.on_products"),
    sales.required("sales.kept_orders.on_shipping"),
  ]);
}

function negate(value: bigint | undefined): bigint | undefined {
  return value === undefined ? undefined : -value;
}

function cashIdentities(collect: IdentityCollector, cash: SectionLines): void {
  // 6. The deposit lines add up to deposits received, in dollars and deposits; received − pulled back + won back = cash received.
  collect.add("identity_6_deposit_lines", "cents", cash.required("cash.received_deposits"), DEPOSIT_RAIL_KEYS.map((key) => cash.part(key)));
  // A rail left out because nothing moved on it counts no deposits.
  collect.add("identity_6_deposit_count", "count", cash.count("cash.received_deposits"), DEPOSIT_RAIL_KEYS.map((key) =>
    cash.line(key) ? cash.count(key) : ZERO));
  collect.add("identity_6_cash_received", "cents", cash.required("cash.received"), [
    cash.required("cash.received_deposits"),
    negate(cash.required("cash.pulled_back", "minus")),
    cash.required("cash.won_back", "plus"),
  ]);
}

function productIdentities(collect: IdentityCollector, sections: FinanceSections, sales: SectionLines): void {
  // 7. The products table adds up to its lines and to Sales.
  const products = sections.products;
  if (products.status !== "ok" || products.total === null) return;
  const rows = [...products.top, ...(products.others ? [products.others] : [])];
  const lines = new SectionLines(products);
  const unlinked = lines.part("products.cogs_unlinked") ?? ZERO;
  const total = products.total;
  collect.add("identity_7_products_billed", "cents", sales.required("sales.billed.product"), [BigInt(total.billedForProduct)]);
  collect.add("identity_7_products_rows_billed", "cents", BigInt(total.billedForProduct), [sumOf(rows.map((row) => row.billedForProduct))]);
  collect.add("identity_7_products_packs", "count", lines.required("products.packs"), [sumOf(rows.map((row) => row.packs))]);
  collect.add("identity_7_products_cogs", "cents", sales.required("sales.cogs", "minus"), [BigInt(total.costOfGoods)]);
  collect.add("identity_7_products_rows_cogs", "cents", BigInt(total.costOfGoods), [
    sumOf(rows.map((row) => row.costOfGoods)),
    unlinked,
    BigInt(products.roundingCents.costOfGoods),
  ]);
  collect.add("identity_7_products_kept", "cents", sales.required("sales.kept_orders.on_products"), [BigInt(total.keptOnProduct)]);
  collect.add("identity_7_products_rows_kept", "cents", BigInt(total.keptOnProduct), [
    sumOf(rows.map((row) => row.keptOnProduct)),
    -unlinked,
    BigInt(products.roundingCents.keptOnProduct),
  ]);
}

function vendorIdentities(collect: IdentityCollector, answer: FinanceAnswer, tiles: FinanceTiles, sections: FinanceSections): void {
  // 8. The vendors table adds up to the page.
  const vendors = sections.vendors;
  if (vendors.status !== "ok" || vendors.total === null) return;
  const rows = [...vendors.top, ...(vendors.others ? [vendors.others] : [])];
  const total = vendors.total;
  const answerOk = answer.status === "ok";
  const pairs: { key: string; page: bigint | null; field: "orders" | "billed" | "keptOnOrders" | "kept" | "weOweNow" | "theyOweNow"; rounding: number }[] = [
    { key: "orders", page: answerOk ? BigInt(answer.orders) : null, field: "orders", rounding: 0 },
    { key: "billed", page: answerOk ? BigInt(answer.billed) : null, field: "billed", rounding: 0 },
    { key: "kept_on_orders", page: answerOk ? numberOrNull(answer.keptOnOrders) : null, field: "keptOnOrders", rounding: vendors.roundingCents.keptOnOrders },
    { key: "kept", page: answerOk ? numberOrNull(answer.kept.amount) : null, field: "kept", rounding: vendors.roundingCents.kept },
    { key: "we_owe", page: numberOrNull(tiles.weOweNow.amount), field: "weOweNow", rounding: 0 },
    { key: "they_owe", page: numberOrNull(tiles.owedToUsNow.amount), field: "theyOweNow", rounding: 0 },
  ];
  for (const pair of pairs) {
    const unit: FinanceUnit = pair.field === "orders" ? "count" : "cents";
    collect.add(`identity_8_vendors_${pair.key}`, unit, pair.page, [sumOf(rows.map((row) => row[pair.field])), BigInt(pair.rounding)]);
    collect.add(`identity_8_vendors_${pair.key}_total`, unit, pair.page, [BigInt(total[pair.field])]);
  }
}

function balanceIdentities(collect: IdentityCollector, sections: FinanceSections, endsNow: boolean): void {
  // 9. The points walk closes, and equals the points held now when the period ends now.
  const points = new SectionLines(sections.points);
  collect.add("identity_9_points_walk", "points", points.required("points.held"), [
    points.required("points.opening"),
    points.part("points.given", "plus"),
    negate(points.part("points.used", "minus")),
    negate(points.part("points.expired", "minus")),
    negate(points.part("points.taken_back", "minus")),
    points.part("points.given_back", "plus"),
  ]);
  if (points.line("points.given")) {
    collect.add("identity_9_points_given_parts", "points", points.required("points.given", "plus"), POINTS_GIVEN_PARTS.map((key) => points.part(key)));
  }
  if (endsNow) collect.add("identity_9_points_held_now", "points", points.required("points.held_now"), [points.required("points.held")]);

  // 10. The pool walk closes.
  const pool = new SectionLines(sections.pool);
  collect.add("identity_10_pool_walk", "cents", pool.required("pool.closing"), [
    pool.required("pool.opening"),
    pool.required("pool.set_aside", "plus"),
    negate(pool.required("pool.paid_out", "minus")),
    pool.required("pool.topped_up", "plus"),
  ]);
  collect.add("identity_10_pool_paid_parts", "cents", pool.required("pool.paid_out", "minus"), POOL_PAID_PARTS.map((key) => pool.part(key)));

  // 11. The owed walk closes, and its split is the closing.
  const owed = new SectionLines(sections.owed);
  collect.add("identity_11_owed_walk", "cents", owed.required("owed.walk.closing"), [
    owed.required("owed.walk.opening"),
    ...OWED_WALK_MOVEMENTS.map(({ key, usual }) => {
      const value = owed.part(key, usual);
      return usual === "minus" ? negate(value) : value;
    }),
  ]);
  collect.add("identity_11_owed_split", "cents", owed.required("owed.walk.closing"), [
    owed.required("owed.walk.we_owe"),
    negate(owed.required("owed.walk.they_owe")),
  ]);
}

function crossSectionIdentities(collect: IdentityCollector, sections: FinanceSections, sales: SectionLines): void {
  // 12. Returns: credits − fees = net, and the two credit lines make up what was credited.
  const returns = new SectionLines(sections.returns);
  collect.add("identity_12_returns_net", "cents", returns.required("returns.net"), [
    returns.required("returns.credits_cs"),
    returns.required("returns.credits_pool"),
    negate(returns.required("returns.fees", "minus")),
  ]);
  collect.add("identity_12_returns_credited", "cents", returns.required("returns.credited"), [
    returns.required("returns.credits_cs"),
    returns.required("returns.credits_pool"),
  ]);

  // 13. Points used = paid with points (1 point = 1¢).
  const points = new SectionLines(sections.points);
  collect.add("identity_13_points_used", "cents", sales.required("sales.billed.paid_with_points"), [points.required("points.used", "minus")]);
  collect.add("identity_13_points_used_value", "cents", sales.required("sales.billed.paid_with_points"), [points.required("points.used.billed_value")]);

  // 14. The pool set aside (Q8) = the pool share billed (Q1).
  const pool = new SectionLines(sections.pool);
  collect.add("identity_14_pool_set_aside", "cents", sales.required("sales.billed.pool_share"), [pool.required("pool.set_aside", "plus")]);
}

/**
 * Check P1 (contract §3, recon 22): the 14 page identities over the summary
 * itself, each sub-identity with its own detail key. An identity is
 * examined only when every figure it needs is on the page with a number;
 * it is an exception when found ≠ expected.
 */
export function checkSummaryIdentities(input: FinanceIdentityInput): FinanceIdentityReport {
  const collect = new IdentityCollector();
  const sales = new SectionLines(input.sections.sales);
  salesIdentities(collect, input.answer, sales);
  cashIdentities(collect, new SectionLines(input.sections.cash));
  productIdentities(collect, input.sections, sales);
  vendorIdentities(collect, input.answer, input.tiles, input.sections);
  balanceIdentities(collect, input.sections, input.endsNow);
  crossSectionIdentities(collect, input.sections, sales);
  const examined = Object.freeze([...collect.examined]);
  return Object.freeze({ examined, exceptions: Object.freeze(examined.filter((item) => item.found !== item.expected)) });
}
