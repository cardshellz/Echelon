/**
 * The Program finance summary, assembled from the raw aggregates of one
 * snapshot (contract §2.1–§2.9, §3): the answer card, the four tiles, the
 * eight statement sections, the 27 checks, the information lines and the
 * policy-era notes. The output is parsed with financeSummarySchema before
 * it is returned, so nothing that breaks the contract leaves this module.
 *
 * Pure: no clock (generatedAt and the windows arrive in the context), no
 * I/O, no logging. Every sum is BigInt; a figure becomes a JSON number only
 * here, through toSafeNumber, and one that is not exactly representable is
 * shown as "unavailable" (DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE), never as
 * 0. The service logs what financeSummaryDiagnostics reports.
 *
 * Amounts on "plus"/"minus" lines are unsigned and the operator carries the
 * direction (a negative cost flips "minus" to "plus"); "none" and "equals"
 * lines are signed.
 */

import {
  FINANCE_CHECK_IDS,
  FINANCE_CONTRACT_VERSION,
  FINANCE_PRODUCT_OTHERS_GROUP_KEY,
  FINANCE_PRODUCT_TOTAL_GROUP_KEY,
  FINANCE_SECTION_KEYS,
  FINANCE_TIME_ZONE,
  FINANCE_TOP_ROWS,
  FINANCE_WAITING_REASONS,
  financeSummarySchema,
  type FinanceAnswer,
  type FinanceCheck,
  type FinanceCheckId,
  type FinanceDatedBy,
  type FinanceFigure,
  type FinanceInfoLine,
  type FinanceLine,
  type FinanceLineKey,
  type FinanceNeverChargedKind,
  type FinanceOperator,
  type FinancePrior,
  type FinanceProductRow,
  type FinanceSectionKey,
  type FinanceSectionLineKey,
  type FinanceSections,
  type FinanceSummary,
  type FinanceSummaryInput,
  type FinanceTiles,
  type FinanceVendorAggregateRow,
  type FinanceVendorName,
  type FinanceVendorRow,
  type FinanceWorkingStep,
} from "../../../../shared/dropship/program-finance";
import {
  FINANCE_CHECK_DEFINITIONS,
  type FinanceReasonKey,
} from "../../../../shared/dropship/program-finance-definitions";
import { signedMillsToCents, toSafeNumber } from "../../../../shared/dropship/program-finance-money";
import { DropshipError } from "./errors";
import { toFinanceWindow, type FinanceLocalWindow } from "./program-finance-period";
import {
  FINANCE_TABLES,
  type FinanceCashLine,
  type FinanceRawAggregates,
  type FinanceRawCheckCounts,
  type FinanceRawDisputes,
  type FinanceRawLedger,
  type FinanceRawLedgerGroup,
  type FinanceRawOrderTotals,
  type FinanceRawOrders,
  type FinanceRawPool,
  type FinanceRawProductGroupRow,
  type FinanceRawProducts,
  type FinanceRawResult,
  type FinanceRawVendorRow,
  type FinanceRawWallet,
  type FinanceTableKey,
} from "./program-finance-raw";
import {
  barWidths,
  buildFinancePrior,
  centsOfEachDollar,
  checkSummaryIdentities,
  financePolicyEraNotes,
  financeShare,
  financeVendorName,
  type FinanceBarParts,
  type FinanceBilledParts,
  type FinanceCompareValue,
} from "./program-finance-rules";
import {
  FINANCE_AMOUNT_OUT_OF_RANGE_CODE,
  FINANCE_CONTRACT_VIOLATION_CODE,
  FINANCE_DATA_INVALID_CODE,
  FINANCE_INTERNAL_ERROR_CODE,
  FinanceFigureError,
  LedgerView,
  LineSet,
  PROGRAM_WIDE,
  TABLE_MISSING,
  UNEXPECTED_TYPES,
  abs,
  availableType,
  cashDeposit,
  causeOf,
  cents,
  count,
  deposit,
  directedLine,
  lineWorking,
  max0,
  notRecordedLine,
  nullableCents,
  ofType,
  optionalId,
  recordedLine,
  rewardsType,
  sourceOf,
  staffCredit,
  stepOf,
  sumBig,
  unavailableLine,
  operandsOf,
  type FinanceWorkingOperand,
  type GroupFilter,
  type LineOptions,
  type Source,
  type Unavailable,
} from "./program-finance-lines";

export {
  FINANCE_AMOUNT_OUT_OF_RANGE_CODE,
  FINANCE_CONTRACT_VIOLATION_CODE,
  FINANCE_DATA_INVALID_CODE,
  FINANCE_INTERNAL_ERROR_CODE,
  FINANCE_TABLE_MISSING_CODE,
} from "./program-finance-lines";

/** What the builder needs besides the raw aggregates; the service supplies it. */
export interface FinanceSummaryContext {
  /** The injected clock's reading; the period's endAt when it ends now. */
  readonly generatedAt: Date;
  readonly period: FinanceLocalWindow;
  /** Null when Compare is off or the period is all time. */
  readonly comparePeriod: FinanceLocalWindow | null;
  /** The vendor in view (financeVendorName of its row), or null for the whole program. */
  readonly vendor: FinanceVendorName | null;
}

const ZERO = BigInt(0);
/** Contract bounds on a product row's group key and a vendor's status text (financeProductRowSchema, financeVendorRowSchema). */
const MAX_PRODUCT_GROUP_KEY = 140;
const MAX_VENDOR_STATUS = 30;
/** contract mills: signed decimal text of at most 20 digits. */
const MILLS_TEXT_PATTERN = /^-?\d{1,20}$/;

// ── derived figures (one place, BigInt) ─────────────────────────────────

interface OrderFigures {
  readonly totals: FinanceRawOrderTotals;
  readonly waitingBilled: bigint;
  readonly waitingOrders: bigint;
  readonly costOfGoods: bigint;
  readonly keptOnOrders: bigint;
  readonly keptOnProducts: bigint;
  readonly keptOnShipping: bigint;
}

function orderFigures(orders: FinanceRawOrders): OrderFigures {
  const t = orders.totals;
  const costOfGoods = signedMillsToCents(t.cogsMillsFc);
  return {
    totals: t,
    waitingBilled: t.billed - t.billedFc,
    waitingOrders: t.orders - t.fcOrders,
    costOfGoods,
    keptOnOrders: t.billedFc - costOfGoods - t.labelsFc - t.poolFc,
    keptOnProducts: t.productBilledFc - costOfGoods,
    keptOnShipping: t.shippingNetPoolFc - t.labelsFc,
  };
}

interface FeeFigures {
  readonly advance: bigint;
  readonly card: bigint;
  readonly returns: bigint;
  readonly total: bigint;
  readonly returnCredits: bigint;
  /** A deposit's charged or card-fee amount was not whole cents (D7). */
  readonly partial: boolean;
}

function feeFigures(ledger: LedgerView): FeeFigures {
  const advance = -ledger.sum("amountP", ofType("advance_fee"));
  const card = ledger.sum("cardFeeP", deposit());
  const returns = -ledger.sum("amountP", ofType("return_fee"));
  return {
    advance,
    card,
    returns,
    total: advance + card + returns,
    returnCredits: ledger.sum("amountP", ofType("return_credit")),
    partial: ledger.sum("malformedP", deposit()) > ZERO,
  };
}

interface CashFigures {
  readonly deposits: bigint;
  readonly depositsPartial: boolean;
  readonly pulledBack: bigint;
  readonly pulledBackPartial: boolean;
  /** Null when the dispute statement failed. */
  readonly wonBack: bigint | null;
  readonly wonBackCount: bigint;
  readonly wonBackPartialReason: FinanceReasonKey | null;
  readonly received: bigint | null;
  readonly receivedPartialReason: FinanceReasonKey | null;
}

function wonBackOf(disputes: FinanceRawDisputes | null, window: "inP" | "inCompare"): { total: bigint; count: bigint; partialReason: FinanceReasonKey | null } | null {
  if (!disputes) return null;
  let total = ZERO;
  let wins = ZERO;
  let partialReason: FinanceReasonKey | null = null;
  for (const win of disputes.won) {
    if (!win[window]) continue;
    wins += BigInt(1);
    if (win.reversalId === null) partialReason = partialReason ?? "reversal_not_paired";
    else if (win.disputedCents === null) partialReason = partialReason ?? "dispute_amount_missing";
    else total += win.disputedCents;
  }
  return { total, count: wins, partialReason };
}

function cashFigures(ledger: LedgerView, disputes: FinanceRawDisputes | null): CashFigures {
  const deposits = ledger.sum("chargedP", cashDeposit);
  const depositsPartial = ledger.sum("malformedP", cashDeposit) > ZERO;
  const pulledBack = ledger.sum("disputeP", ofType("funding_reversal"));
  const pulledBackPartial = ledger.sum("disputeMissingP", ofType("funding_reversal")) > ZERO;
  const won = wonBackOf(disputes, "inP");
  const receivedPartialReason: FinanceReasonKey | null = depositsPartial
    ? "metadata_malformed"
    : pulledBackPartial
      ? "dispute_amount_missing"
      : won?.partialReason ?? null;
  return {
    deposits,
    depositsPartial,
    pulledBack,
    pulledBackPartial,
    wonBack: won ? won.total : null,
    wonBackCount: won ? won.count : ZERO,
    wonBackPartialReason: won?.partialReason ?? null,
    received: won ? deposits - pulledBack + won.total : null,
    receivedPartialReason,
  };
}

function compareCashReceived(ledger: LedgerView | null, disputes: FinanceRawDisputes | null, hasCompare: boolean): FinanceCompareValue {
  if (!hasCompare) return null;
  const won = wonBackOf(disputes, "inCompare");
  if (!ledger || !won) return "unavailable";
  return ledger.sum("chargedCmp", cashDeposit) - ledger.sum("disputeCmp", ofType("funding_reversal")) + won.total;
}

interface WalletFigures {
  readonly weOwe: bigint;
  readonly weOweWallets: bigint;
  readonly theyOwe: bigint;
  readonly theyOweWallets: bigint;
  readonly onTheWay: bigint;
  readonly onTheWayWallets: bigint;
  readonly wallets: bigint;
  readonly points: bigint;
  readonly expiry: { readonly next30Days: bigint; readonly days31To90: bigint; readonly later: bigint; readonly never: bigint };
}

function walletFigures(wallets: readonly FinanceRawWallet[]): WalletFigures {
  const one = BigInt(1);
  let weOwe = ZERO;
  let weOweWallets = ZERO;
  let theyOwe = ZERO;
  let theyOweWallets = ZERO;
  let onTheWay = ZERO;
  let onTheWayWallets = ZERO;
  let points = ZERO;
  const expiry = { next30Days: ZERO, days31To90: ZERO, later: ZERO, never: ZERO };
  for (const wallet of wallets) {
    if (wallet.available > ZERO) {
      weOwe += wallet.available;
      weOweWallets += one;
    } else if (wallet.available < ZERO) {
      theyOwe += -wallet.available;
      theyOweWallets += one;
    }
    if (wallet.pending !== ZERO) onTheWayWallets += one;
    onTheWay += wallet.pending;
    points += wallet.points;
    expiry.next30Days += wallet.expiresNext30Days;
    expiry.days31To90 += wallet.expiresDays31To90;
    expiry.later += wallet.expiresLater;
    expiry.never += wallet.neverExpires;
  }
  return { weOwe, weOweWallets, theyOwe, theyOweWallets, onTheWay, onTheWayWallets, wallets: BigInt(wallets.length), points, expiry };
}

/** The balance at the end of the period, split by wallet (CD 1 rebuild), from the ledger. */
function endBalances(ledger: LedgerView): { weOwe: bigint; theyOwe: bigint } {
  let weOwe = ZERO;
  let theyOwe = ZERO;
  for (const balance of ledger.byVendor("amountBeforeEnd", availableType).values()) {
    weOwe += max0(balance);
    theyOwe += max0(-balance);
  }
  return { weOwe, theyOwe };
}

// ── the build ───────────────────────────────────────────────────────────

interface Build {
  readonly raw: FinanceRawAggregates;
  readonly context: FinanceSummaryContext;
  readonly endsNow: boolean;
  readonly vendorView: boolean;
  /** "now" for a period that ends now, else "end_of_period": the clock of every closing balance. */
  readonly balanceClock: FinanceDatedBy;
  readonly orders: Source<FinanceRawOrders>;
  readonly orderFigures: OrderFigures | null;
  readonly compareOrders: FinanceRawResult<FinanceRawOrders> | null;
  readonly products: Source<FinanceRawProducts>;
  readonly ledger: Source<FinanceRawLedger>;
  readonly ledgerView: LedgerView | null;
  readonly fees: FeeFigures | null;
  readonly disputes: Source<FinanceRawDisputes>;
  readonly cash: CashFigures | null;
  readonly wallets: Source<readonly FinanceRawWallet[]>;
  readonly walletFigures: WalletFigures | null;
  readonly pool: Source<FinanceRawPool>;
  readonly vendors: Source<readonly FinanceRawVendorRow[]>;
  /** KO + FE − RC; null when the orders or the ledger statement failed. */
  readonly kept: bigint | null;
}

function hasTable(build: Build, key: FinanceTableKey): boolean {
  return build.raw.tables[key] === true;
}

function startBuild(raw: FinanceRawAggregates, context: FinanceSummaryContext): Build {
  const orders = sourceOf(raw.orders);
  const ledger = sourceOf(raw.ledger);
  const disputes = sourceOf(raw.disputes);
  const wallets = sourceOf(raw.wallets);
  const ledgerView = ledger.data ? new LedgerView(ledger.data) : null;
  const figures = orders.data ? orderFigures(orders.data) : null;
  const fees = ledgerView ? feeFigures(ledgerView) : null;
  return {
    raw,
    context,
    endsNow: context.period.endsNow,
    vendorView: context.vendor !== null,
    balanceClock: context.period.endsNow ? "now" : "end_of_period",
    orders,
    orderFigures: figures,
    compareOrders: context.comparePeriod ? raw.compareOrders : null,
    products: sourceOf(raw.products),
    ledger,
    ledgerView,
    fees,
    disputes,
    cash: ledgerView ? cashFigures(ledgerView, disputes.data) : null,
    wallets,
    walletFigures: wallets.data ? walletFigures(wallets.data) : null,
    pool: sourceOf(raw.pool),
    vendors: sourceOf(raw.vendors),
    kept: figures && fees ? figures.keptOnOrders + fees.total - fees.returnCredits : null,
  };
}

/** Q0's bounds must be the instants this module labels the numbers with. */
function assertBoundsMatch(raw: FinanceRawAggregates, context: FinanceSummaryContext): void {
  const same = (a: Date | null, b: Date | null) => (a === null ? b === null : b !== null && a.getTime() === b.getTime());
  const compare = context.comparePeriod;
  const matches =
    same(raw.bounds.startAt, context.period.startAt) &&
    same(raw.bounds.endAt, context.period.endAt) &&
    same(raw.bounds.compareStartAt, compare ? compare.startAt : null) &&
    same(raw.bounds.compareEndAt, compare ? compare.endAt : null);
  if (!matches) {
    throw new DropshipError(FINANCE_INTERNAL_ERROR_CODE, "The database's period bounds differ from the page's.", {
      database: raw.bounds,
      page: { startAt: context.period.startAt, endAt: context.period.endAt, compareStartAt: compare?.startAt ?? null, compareEndAt: compare?.endAt ?? null },
    });
  }
  if (context.period.endsNow && context.period.endAt.getTime() !== context.generatedAt.getTime()) {
    throw new DropshipError(FINANCE_INTERNAL_ERROR_CODE, "A period that ends now must end at generatedAt.", {
      endAt: context.period.endAt,
      generatedAt: context.generatedAt,
    });
  }
}

// ── comparison figures ──────────────────────────────────────────────────

function compareOrderFigures(build: Build): OrderFigures | "unavailable" | null {
  if (!build.context.comparePeriod) return null;
  const result = build.compareOrders;
  if (!result || result.status !== "ok") return "unavailable";
  return orderFigures(result.data);
}

function billedPrior(build: Build): FinancePrior | null {
  const prior = compareOrderFigures(build);
  const current = build.orderFigures ? build.orderFigures.totals.billed : null;
  if (prior === null) return null;
  return buildFinancePrior(current, prior === "unavailable" ? "unavailable" : prior.totals.billed);
}

function cashPrior(build: Build): FinancePrior | null {
  const prior = compareCashReceived(build.ledgerView, build.disputes.data, build.context.comparePeriod !== null);
  return buildFinancePrior(build.cash?.received ?? null, prior);
}

// ── A. Sales ────────────────────────────────────────────────────────────

const SALES_LEDGER_LINES: readonly { key: FinanceSectionLineKey<"sales">; operator: FinanceOperator; datedBy: FinanceDatedBy }[] = [
  { key: "sales.fees", operator: "plus", datedBy: "posted" },
  { key: "sales.fees.advance", operator: "none", datedBy: "posted" },
  { key: "sales.fees.card", operator: "none", datedBy: "settled" },
  { key: "sales.fees.returns", operator: "none", datedBy: "posted" },
  { key: "sales.return_credits_cs", operator: "minus", datedBy: "posted" },
  { key: "sales.kept", operator: "equals", datedBy: "accepted" },
  { key: "sales.memo.staff_credits", operator: "none", datedBy: "settled" },
  { key: "sales.memo.pool_credits", operator: "none", datedBy: "posted" },
];

function addSalesOrderLines(lines: LineSet<"sales">, build: Build, figures: OrderFigures): void {
  const t = figures.totals;
  const accepted: LineOptions = { datedBy: "accepted" };
  lines.add(recordedLine("sales.billed", t.billed, { ...accepted, count: t.orders, prior: billedPrior(build) }));
  lines.add(recordedLine("sales.billed.product", t.productBilled, accepted));
  lines.add(recordedLine("sales.billed.shipping", t.shippingBilled, accepted));
  const quotePartial: FinanceReasonKey | null = t.ordersWithoutQuote > ZERO ? "quote_missing" : null;
  for (const [key, value] of [["sales.billed.carrier_estimate", t.quoteBase], ["sales.billed.markup", t.quoteMarkup]] as const) {
    lines.add(hasTable(build, "quotes")
      ? recordedLine(key, value, { ...accepted, partialReason: quotePartial })
      : unavailableLine(key, TABLE_MISSING, accepted));
  }
  lines.add(recordedLine("sales.billed.pool_share", t.poolAll, accepted));
  lines.add(recordedLine("sales.billed.paid_from_wallets", t.paidCash, accepted));
  lines.add(recordedLine("sales.billed.paid_with_points", t.paidPoints, accepted));
  lines.add(directedLine("sales.waiting", figures.waitingBilled, "minus", { ...accepted, count: figures.waitingOrders }));
  const byReason = new Map((build.orders.data?.byReason ?? []).map((row) => [row.reason, row]));
  for (const reason of FINANCE_WAITING_REASONS) {
    const row = byReason.get(reason);
    if (row && row.orders > ZERO) lines.add(recordedLine(`sales.waiting.${reason}`, row.billed, { ...accepted, count: row.orders }));
  }
  lines.add(recordedLine("sales.billed_fc", t.billedFc, { ...accepted, operator: "equals", count: t.fcOrders }));
  lines.add(directedLine("sales.cogs", figures.costOfGoods, "minus", accepted));
  lines.add(directedLine("sales.labels", t.labelsFc, "minus", accepted));
  lines.add(recordedLine("sales.labels.replacement", t.replacementLabelsFc, { ...accepted, everyLineWhenZero: true }));
  lines.add(directedLine("sales.pool_fc", t.poolFc, "minus", accepted));
  lines.add(notRecordedLine("sales.packaging", "packaging_not_saved", "accepted"));
  lines.add(recordedLine("sales.kept_orders", figures.keptOnOrders, {
    ...accepted, operator: "equals", share: financeShare(figures.keptOnOrders, t.billedFc),
  }));
  lines.add(recordedLine("sales.kept_orders.on_products", figures.keptOnProducts, {
    ...accepted, share: financeShare(figures.keptOnProducts, t.productBilledFc),
  }));
  lines.add(recordedLine("sales.kept_orders.on_shipping", figures.keptOnShipping, {
    ...accepted, share: financeShare(figures.keptOnShipping, t.shippingNetPoolFc),
  }));
  lines.add(recordedLine("sales.memo.points_used", t.paidPoints, { ...accepted, everyLineWhenZero: true }));
  lines.add(recordedLine("sales.buyer_paid", t.buyerPaid, {
    ...accepted, count: t.buyerUnknown, partialReason: t.buyerUnknown > ZERO ? "buyer_total_unknown" : null,
  }));
  lines.add(recordedLine("sales.label_coverage", t.coverageLabelsCosted, {
    ...accepted, coverage: { done: t.coverageLabelsCosted, total: t.coverageLabels },
  }));
}

function addSalesLedgerLines(lines: LineSet<"sales">, build: Build, figures: OrderFigures): void {
  const fees = build.fees;
  const ledger = build.ledgerView;
  if (!fees || !ledger) {
    const cause = causeOf(build.ledger);
    for (const entry of SALES_LEDGER_LINES) lines.add(unavailableLine(entry.key, cause, entry));
    return;
  }
  const feesPartial: FinanceReasonKey | null = fees.partial ? "metadata_malformed" : null;
  lines.add(directedLine("sales.fees", fees.total, "plus", { datedBy: "posted", partialReason: feesPartial }));
  lines.add(recordedLine("sales.fees.advance", fees.advance, { datedBy: "posted" }));
  lines.add(recordedLine("sales.fees.card", fees.card, { datedBy: "settled", everyLineWhenZero: true, partialReason: feesPartial }));
  lines.add(recordedLine("sales.fees.returns", fees.returns, { datedBy: "posted" }));
  lines.add(directedLine("sales.return_credits_cs", fees.returnCredits, "minus", { datedBy: "posted" }));
  lines.add(recordedLine("sales.kept", figures.keptOnOrders + fees.total - fees.returnCredits, {
    datedBy: "accepted", operator: "equals", partialReason: feesPartial,
  }));
  lines.add(recordedLine("sales.memo.staff_credits", ledger.sum("amountP", staffCredit), { datedBy: "settled", everyLineWhenZero: true }));
  lines.add(recordedLine("sales.memo.pool_credits", ledger.sum("amountP", ofType("insurance_pool_credit")), {
    datedBy: "posted", everyLineWhenZero: true,
  }));
}

/** The never-charged kinds that were held for payment, and so have a "would have charged" amount. */
const HELD_FOR_PAYMENT: ReadonlySet<FinanceNeverChargedKind> = new Set(["waiting_for_payment", "payment_time_ran_out"]);

function addNeverChargedLines(lines: LineSet<"sales">, build: Build): void {
  const neverCharged = sourceOf(build.raw.neverCharged);
  if (!neverCharged.data) {
    lines.add(unavailableLine("sales.never_charged", causeOf(neverCharged), { datedBy: "received" }));
    return;
  }
  const rows = neverCharged.data;
  const total = sumBig(rows.map((row) => row.orders));
  lines.add(recordedLine("sales.never_charged", total, { datedBy: "received", count: total }));
  const byKind = new Map<FinanceNeverChargedKind, bigint>();
  for (const row of rows) byKind.set(row.kind, (byKind.get(row.kind) ?? ZERO) + row.orders);
  for (const [kind, orders] of byKind) {
    if (orders > ZERO) lines.add(recordedLine(`sales.never_charged.${kind}`, orders, { datedBy: "received" }));
  }
  const held = rows.filter((row) => HELD_FOR_PAYMENT.has(row.kind));
  if (held.length === 0) return;
  lines.add(hasTable(build, "audit")
    ? recordedLine("sales.never_charged.would_have_charged", sumBig(held.map((row) => row.wouldHaveCharged ?? ZERO)), { datedBy: "received" })
    : unavailableLine("sales.never_charged.would_have_charged", TABLE_MISSING, { datedBy: "received" }));
}

function salesSection(build: Build): FinanceSections["sales"] {
  const figures = build.orderFigures;
  if (!figures) return failedSection(build.orders);
  const lines = new LineSet("sales");
  addSalesOrderLines(lines, build, figures);
  addSalesLedgerLines(lines, build, figures);
  lines.add(notRecordedLine("sales.memo.stripe_fees", "stripe_fees_not_saved", "settled"));
  lines.add(notRecordedLine("sales.memo.overheads", "overheads_not_on_page", "accepted"));
  addNeverChargedLines(lines, build);
  lineWorking(lines, "sales.billed_fc", ["sales.billed", "sales.waiting"]);
  lineWorking(lines, "sales.kept_orders", ["sales.billed_fc", "sales.cogs", "sales.labels", "sales.pool_fc"]);
  lineWorking(lines, "sales.kept", ["sales.kept_orders", "sales.fees", "sales.return_credits_cs"]);
  return { status: "ok", lines: lines.sorted() };
}

/** A section whose own statement failed: its error code and no numbers at all. */
function failedSection<T>(source: Source<T>): { status: "error" | "skipped"; errorCode: string; lines: [] } {
  const cause = causeOf(source);
  return { status: cause.status, errorCode: cause.errorCode, lines: [] };
}

// ── B. Products ─────────────────────────────────────────────────────────

interface ProductTotals {
  packs: bigint;
  pieces: bigint | null;
  linesWithoutPieces: bigint;
  packsShipped: bigint;
  packsFc: bigint;
  billed: bigint;
  billedFc: bigint;
  costOfGoods: bigint;
  mills: bigint;
  kept: bigint;
}

function millsText(mills: bigint, what: string): string {
  const text = mills.toString();
  if (!MILLS_TEXT_PATTERN.test(text)) throw new FinanceFigureError(FINANCE_AMOUNT_OUT_OF_RANGE_CODE, what);
  return text;
}

function productRowFrom(identity: Pick<FinanceProductRow, "groupKey" | "productVariantId" | "productId" | "productName" | "sizeName" | "sku"> & { unitsPerVariant: bigint | null }, figures: ProductTotals): FinanceProductRow {
  const what = `products.${identity.groupKey}`;
  if (identity.groupKey.length > MAX_PRODUCT_GROUP_KEY) throw new FinanceFigureError(FINANCE_DATA_INVALID_CODE, what);
  return {
    groupKey: identity.groupKey,
    productVariantId: optionalId(identity.productVariantId, what),
    productId: optionalId(identity.productId, what),
    productName: identity.productName,
    sizeName: identity.sizeName,
    sku: identity.sku,
    unitsPerVariant: identity.unitsPerVariant === null ? null : count(identity.unitsPerVariant, what),
    packs: count(figures.packs, what),
    pieces: figures.pieces === null ? null : count(figures.pieces, what),
    linesWithoutPieces: count(figures.linesWithoutPieces, what),
    packsShipped: count(figures.packsShipped, what),
    packsFullyCosted: count(figures.packsFc, what),
    billedForProduct: cents(figures.billed, what),
    billedOnFullyCosted: cents(figures.billedFc, what),
    costOfGoods: cents(figures.costOfGoods, what),
    costOfGoodsMills: millsText(figures.mills, what),
    keptOnProduct: cents(figures.kept, what),
    keptTenths: nullableCents(financeShare(figures.kept, figures.billedFc).tenths),
  };
}

function groupFigures(group: FinanceRawProductGroupRow): ProductTotals {
  const costOfGoods = signedMillsToCents(group.cogsMillsFc);
  return {
    packs: group.packs,
    pieces: group.pieces,
    linesWithoutPieces: group.linesWithoutPieces,
    packsShipped: group.packsShipped,
    packsFc: group.packsFc,
    billed: group.billedProduct,
    billedFc: group.billedProductFc,
    costOfGoods,
    mills: group.cogsMillsFc,
    kept: group.billedProductFc - costOfGoods,
  };
}

/** "All other products": the sum of the rows it stands for, each row's cents as shown. */
function addUp(rows: readonly ProductTotals[]): ProductTotals {
  const pieces = rows.filter((row) => row.pieces !== null).map((row) => row.pieces as bigint);
  return {
    packs: sumBig(rows.map((row) => row.packs)),
    pieces: pieces.length > 0 ? sumBig(pieces) : null,
    linesWithoutPieces: sumBig(rows.map((row) => row.linesWithoutPieces)),
    packsShipped: sumBig(rows.map((row) => row.packsShipped)),
    packsFc: sumBig(rows.map((row) => row.packsFc)),
    billed: sumBig(rows.map((row) => row.billed)),
    billedFc: sumBig(rows.map((row) => row.billedFc)),
    costOfGoods: sumBig(rows.map((row) => row.costOfGoods)),
    mills: sumBig(rows.map((row) => row.mills)),
    kept: sumBig(rows.map((row) => row.kept)),
  };
}

const AGGREGATE_IDENTITY = { productVariantId: null, productId: null, productName: null, sizeName: null, sku: null, unitsPerVariant: null };

function byBilledThenKey(a: FinanceRawProductGroupRow, b: FinanceRawProductGroupRow): number {
  if (a.billedProduct !== b.billedProduct) return a.billedProduct > b.billedProduct ? -1 : 1;
  return a.groupKey < b.groupKey ? -1 : a.groupKey > b.groupKey ? 1 : 0;
}

function productsSection(build: Build): FinanceSections["products"] {
  const products = build.products.data;
  const emptyTable = { top: [], others: null, total: null, roundingCents: { costOfGoods: 0, keptOnProduct: 0 } };
  if (!products) return { ...failedSection(build.products), ...emptyTable };
  try {
    return { status: "ok", ...productTable(products), lines: productLines(build, products) };
  } catch (error) {
    if (!(error instanceof FinanceFigureError)) throw error;
    return { status: "error", errorCode: error.code, lines: [], ...emptyTable };
  }
}

function productTable(products: FinanceRawProducts): Omit<FinanceSections["products"], "status" | "errorCode" | "lines"> {
  const groups = [...products.groups].sort(byBilledThenKey);
  if (groups.length === 0) return { top: [], others: null, total: null, roundingCents: { costOfGoods: 0, keptOnProduct: 0 } };
  const rowFigures = groups.map(groupFigures);
  const top = groups.slice(0, FINANCE_TOP_ROWS).map((group, index) => productRowFrom(group, rowFigures[index]));
  const rest = rowFigures.slice(FINANCE_TOP_ROWS);
  const others = rest.length > 0 ? productRowFrom({ groupKey: FINANCE_PRODUCT_OTHERS_GROUP_KEY, ...AGGREGATE_IDENTITY }, addUp(rest)) : null;

  const t = products.totals;
  const totalMills = t.cogsMillsFc + t.unlinkedCogsMillsFc;
  const totalCost = signedMillsToCents(totalMills);
  const unlinkedCost = signedMillsToCents(t.unlinkedCogsMillsFc);
  const totalFigures: ProductTotals = {
    packs: t.packs,
    pieces: t.pieces,
    linesWithoutPieces: t.linesWithoutPieces,
    packsShipped: t.packsShipped,
    packsFc: t.packsFc,
    billed: t.billedProduct,
    billedFc: t.billedProductFc,
    costOfGoods: totalCost,
    mills: totalMills,
    kept: t.billedProductFc - totalCost,
  };
  const rowsCost = sumBig(rowFigures.map((row) => row.costOfGoods));
  const rowsKept = sumBig(rowFigures.map((row) => row.kept));
  return {
    top,
    others,
    total: productRowFrom({ groupKey: FINANCE_PRODUCT_TOTAL_GROUP_KEY, ...AGGREGATE_IDENTITY }, totalFigures),
    // The unlinked cost has its own line, so what is left over is rounding alone:
    // rows + unlinked + rounding = total (cost), rows − unlinked + rounding = total (kept).
    roundingCents: {
      costOfGoods: cents(totalCost - rowsCost - unlinkedCost, "products.rounding"),
      keptOnProduct: cents(totalFigures.kept - rowsKept + unlinkedCost, "products.rounding"),
    },
  };
}

function productLines(build: Build, products: FinanceRawProducts): FinanceLine[] {
  const t = products.totals;
  const accepted: LineOptions = { datedBy: "accepted" };
  const lines = new LineSet("products");
  lines.add(recordedLine("products.billed", t.billedProduct, accepted));
  lines.add(recordedLine("products.packs", t.packs, accepted));
  if (!hasTable(build, "variants")) {
    lines.add(unavailableLine("products.pieces", TABLE_MISSING, accepted));
  } else {
    lines.add(recordedLine("products.pieces", t.pieces ?? ZERO, {
      ...accepted, partialReason: t.linesWithoutPieces > ZERO ? "pieces_not_recorded" : null,
    }));
    if (t.linesWithoutPieces > ZERO) lines.add(recordedLine("products.lines_without_pieces", t.linesWithoutPieces, accepted));
  }
  lines.add(recordedLine("products.count", BigInt(products.groups.length), accepted));
  lines.add(recordedLine("products.packs_fully_costed", t.packsFc, { ...accepted, coverage: { done: t.packsFc, total: t.packs } }));
  // Over-shipped packs would read "19 of 18"; the coverage is left off and check O6 lists them.
  lines.add(recordedLine("products.packs_shipped", t.packsShipped, { ...accepted, coverage: { done: t.packsShipped, total: t.packs } }));
  if (t.unlinkedCogsMillsFc !== ZERO) {
    lines.add(recordedLine("products.cogs_unlinked", signedMillsToCents(t.unlinkedCogsMillsFc), accepted));
  }
  return lines.sorted();
}

// ── C. Cash in ──────────────────────────────────────────────────────────

const RAIL_LINES: readonly { key: FinanceSectionLineKey<"cash">; cashLine: FinanceCashLine; onlyWhenMoved: boolean }[] = [
  { key: "cash.ach", cashLine: "stripe_ach", onlyWhenMoved: false },
  { key: "cash.card", cashLine: "stripe_card", onlyWhenMoved: false },
  { key: "cash.usdc", cashLine: "usdc_base", onlyWhenMoved: false },
  { key: "cash.collection", cashLine: "collection", onlyWhenMoved: true },
  { key: "cash.unknown", cashLine: "unknown", onlyWhenMoved: true },
];

function addDepositLines(lines: LineSet<"cash">, ledger: LedgerView): void {
  const settled: LineOptions = { datedBy: "settled" };
  for (const rail of RAIL_LINES) {
    const filter = deposit(rail.cashLine);
    const deposits = ledger.sum("nP", filter);
    if (rail.onlyWhenMoved && deposits === ZERO) continue;
    lines.add(recordedLine(rail.key, ledger.sum("chargedP", filter), {
      ...settled, count: deposits, partialReason: ledger.sum("malformedP", filter) > ZERO ? "metadata_malformed" : null,
    }));
  }
  const cardFees = ledger.sum("cardFeeP", deposit("stripe_card"));
  if (cardFees !== ZERO) lines.add(recordedLine("cash.card.fees", cardFees, settled));
  const usdc = deposit("usdc_base");
  const watcher = ledger.sum("chargedP", (group) => usdc(group) && group.chainWatcher === true);
  const confirmed = ledger.sum("chargedP", (group) => usdc(group) && group.chainWatcher !== true);
  if (watcher !== ZERO) lines.add(recordedLine("cash.usdc.chain_watcher", watcher, settled));
  if (confirmed !== ZERO) lines.add(recordedLine("cash.usdc.staff_confirmed", confirmed, settled));
}

function addCashMemoLines(lines: LineSet<"cash">, build: Build, ledger: LedgerView): void {
  const autoTopUp = (group: FinanceRawLedgerGroup) => deposit()(group) && group.autoReload === true;
  lines.add(recordedLine("cash.memo.auto_top_ups", ledger.sum("chargedP", autoTopUp), {
    datedBy: "settled", count: ledger.sum("nP", autoTopUp), everyLineWhenZero: true,
  }));
  for (const [key, reason] of [["cash.memo.auto_top_ups.minimum_balance", "minimum_balance"], ["cash.memo.auto_top_ups.payment_hold", "payment_hold"]] as const) {
    const amount = ledger.sum("chargedP", (group) => autoTopUp(group) && group.autoReloadReason === reason);
    if (amount !== ZERO) lines.add(recordedLine(key, amount, { datedBy: "settled" }));
  }
  lines.add(recordedLine("cash.memo.on_the_way", ledger.sum("amountPendingNow", deposit()), {
    datedBy: "now", count: ledger.sum("nPendingNow", deposit()),
  }));
  lines.add(recordedLine("cash.memo.stuck", ledger.sum("amountStale", deposit()), { datedBy: "now", count: ledger.sum("nStale", deposit()) }));
  const failed = ledger.sum("nFailedP", deposit());
  lines.add(recordedLine("cash.memo.failed", ledger.sum("amountFailedP", deposit()), {
    datedBy: "posted",
    count: failed,
    partialReason: ledger.sum("failedWithoutTime", deposit()) > ZERO ? "failure_time_missing" : null,
    failureCode: failed > ZERO ? ledger.ledger.firstFailureCode : null,
  }));
  const disputes = build.disputes;
  lines.add(disputes.data
    ? recordedLine("cash.memo.not_won_back", disputes.data.notWonBack.disputedCents, { datedBy: "posted", count: disputes.data.notWonBack.disputes })
    : unavailableLine("cash.memo.not_won_back", disputes.failure, { datedBy: "posted" }));
  lines.add(recordedLine("cash.memo.staff_credits", ledger.sum("amountP", staffCredit), { datedBy: "settled", count: ledger.sum("nP", staffCredit) }));
  lines.add(notRecordedLine("cash.memo.stripe_fees", "stripe_fees_not_saved", "settled"));
  lines.add(notRecordedLine("cash.memo.usdc_moved_out", "usdc_moves_not_saved", "settled"));
}

function cashSection(build: Build): FinanceSections["cash"] {
  const ledger = build.ledgerView;
  const cash = build.cash;
  if (!ledger || !cash) return failedSection(build.ledger);
  const lines = new LineSet("cash");
  addDepositLines(lines, ledger);
  lines.add(recordedLine("cash.received_deposits", cash.deposits, {
    datedBy: "settled", operator: "equals", partialReason: cash.depositsPartial ? "metadata_malformed" : null,
  }));
  lines.add(directedLine("cash.pulled_back", cash.pulledBack, "minus", {
    datedBy: "posted",
    count: ledger.sum("nP", ofType("funding_reversal")),
    partialReason: cash.pulledBackPartial ? "dispute_amount_missing" : null,
  }));
  if (cash.wonBack === null || cash.received === null) {
    const cause = causeOf(build.disputes);
    lines.add(unavailableLine("cash.won_back", cause, { datedBy: "posted", operator: "plus" }));
    lines.add(unavailableLine("cash.received", cause, { datedBy: "settled", operator: "equals" }));
  } else {
    lines.add(directedLine("cash.won_back", cash.wonBack, "plus", {
      datedBy: "posted", count: cash.wonBackCount, partialReason: cash.wonBackPartialReason,
    }));
    lines.add(recordedLine("cash.received", cash.received, {
      datedBy: "settled", operator: "equals", prior: cashPrior(build), partialReason: cash.receivedPartialReason,
    }));
  }
  addCashMemoLines(lines, build, ledger);
  lineWorking(lines, "cash.received", ["cash.received_deposits", "cash.pulled_back", "cash.won_back"]);
  return { status: "ok", lines: lines.sorted() };
}

// ── D. Returns and credits ──────────────────────────────────────────────

const CS_CREDIT_PARTS: readonly { key: FinanceSectionLineKey<"returns">; referenceType: string }[] = [
  { key: "returns.credits_cs.inspected", referenceType: "dropship_rma" },
  { key: "returns.credits_cs.return_case", referenceType: "return_case_vendor_settlement" },
];

/** Pool-paid credits by kind (spec §3.4.D), shared by the Returns and Pool rows. */
const POOL_CREDIT_KINDS = [
  { suffix: "no_inspection", referenceType: "dropship_rma_no_inspection" },
  { suffix: "inspection_fault", referenceType: "dropship_rma" },
  { suffix: "return_case_fault", referenceType: "return_case_vendor_settlement" },
] as const;

function addFeePartLines(lines: LineSet<"returns">, build: Build): void {
  const posted: LineOptions = { datedBy: "posted" };
  const partKeys = ["returns.fees.restocking", "returns.fees.processing", "returns.fees.return_label"] as const;
  const missingTable = !hasTable(build, "settlements") || !hasTable(build, "inspections");
  const returnFees = sourceOf(build.raw.returnFees);
  if (missingTable || !returnFees.data) {
    const cause = missingTable ? TABLE_MISSING : causeOf(returnFees);
    for (const key of partKeys) lines.add(unavailableLine(key, cause, posted));
    return;
  }
  const rows = returnFees.data;
  const parts = [sumBig(rows.map((row) => row.restocking)), sumBig(rows.map((row) => row.processing)), sumBig(rows.map((row) => row.returnLabel))];
  partKeys.forEach((key, index) => {
    if (parts[index] !== ZERO) lines.add(recordedLine(key, parts[index], posted));
  });
  const splitMissing = sumBig(rows.map((row) => row.splitNotRecorded));
  if (splitMissing > ZERO) lines.add(recordedLine("returns.fees.split_not_recorded", splitMissing, posted));
}

function returnsSection(build: Build): FinanceSections["returns"] {
  const ledger = build.ledgerView;
  if (!ledger) return failedSection(build.ledger);
  const posted: LineOptions = { datedBy: "posted" };
  const lines = new LineSet("returns");
  const csFilter = ofType("return_credit");
  const poolFilter = ofType("insurance_pool_credit");
  const fromCardShellz = ledger.sum("amountP", csFilter);
  const fromPool = ledger.sum("amountP", poolFilter);
  const fees = -ledger.sum("amountP", ofType("return_fee"));
  lines.add(recordedLine("returns.credited", fromCardShellz + fromPool, {
    ...posted, count: ledger.sum("nP", csFilter) + ledger.sum("nP", poolFilter),
  }));
  lines.add(recordedLine("returns.credits_cs", fromCardShellz, { ...posted, count: ledger.sum("nP", csFilter) }));
  for (const part of CS_CREDIT_PARTS) {
    const amount = ledger.sum("amountP", (group) => csFilter(group) && group.referenceType === part.referenceType);
    if (amount !== ZERO) lines.add(recordedLine(part.key, amount, posted));
  }
  lines.add(recordedLine("returns.credits_pool", fromPool, { ...posted, count: ledger.sum("nP", poolFilter) }));
  for (const kind of POOL_CREDIT_KINDS) {
    const amount = ledger.sum("amountP", (group) => poolFilter(group) && group.referenceType === kind.referenceType);
    if (amount !== ZERO) lines.add(recordedLine(`returns.credits_pool.${kind.suffix}`, amount, posted));
  }
  lines.add(directedLine("returns.fees", fees, "minus", posted));
  addFeePartLines(lines, build);
  lines.add(recordedLine("returns.net", fromCardShellz + fromPool - fees, { ...posted, operator: "equals" }));
  lines.add(recordedLine("returns.staff_credits", ledger.sum("amountP", staffCredit), { datedBy: "settled", count: ledger.sum("nP", staffCredit) }));
  lines.add(notRecordedLine("returns.memo.order_refunds", "no_refund_path", "posted"));
  lines.add(notRecordedLine("returns.memo.restocked_value", "restocked_value_not_saved", "posted"));
  lines.add(notRecordedLine("returns.memo.return_label_cost", "return_label_cost_not_saved", "posted"));
  lineWorking(lines, "returns.net", ["returns.credits_cs", "returns.credits_pool", "returns.fees"]);
  return { status: "ok", lines: lines.sorted() };
}

// ── E. What we owe and are owed ─────────────────────────────────────────

const WALK_MOVEMENTS: readonly {
  key: FinanceSectionLineKey<"owed">;
  filter: GroupFilter;
  usual: "plus" | "minus";
  datedBy: FinanceDatedBy;
}[] = [
  { key: "owed.walk.deposits", filter: cashDeposit, usual: "plus", datedBy: "settled" },
  { key: "owed.walk.staff_credits", filter: staffCredit, usual: "plus", datedBy: "settled" },
  { key: "owed.walk.return_credits_cs", filter: ofType("return_credit"), usual: "plus", datedBy: "posted" },
  { key: "owed.walk.return_credits_pool", filter: ofType("insurance_pool_credit"), usual: "plus", datedBy: "posted" },
  { key: "owed.walk.disputes_won", filter: ofType("funding_reinstated"), usual: "plus", datedBy: "posted" },
  { key: "owed.walk.orders", filter: ofType("order_debit"), usual: "minus", datedBy: "posted" },
  { key: "owed.walk.advance_fees", filter: ofType("advance_fee"), usual: "minus", datedBy: "posted" },
  { key: "owed.walk.return_fees", filter: ofType("return_fee"), usual: "minus", datedBy: "posted" },
  { key: "owed.walk.disputes_taken", filter: ofType("funding_reversal"), usual: "minus", datedBy: "posted" },
];

const WALK_RESULT_KEYS: readonly FinanceSectionLineKey<"owed">[] = [
  "owed.walk.opening", ...WALK_MOVEMENTS.map((movement) => movement.key), "owed.walk.closing", "owed.walk.we_owe", "owed.walk.they_owe",
];

function addWalkLines(lines: LineSet<"owed">, build: Build): void {
  const ledger = build.ledgerView;
  if (!ledger) {
    for (const key of WALK_RESULT_KEYS) lines.add(unavailableLine(key, causeOf(build.ledger), { datedBy: build.balanceClock }));
    return;
  }
  const opening = ledger.sum("amountBeforeStart", availableType);
  const closing = ledger.sum("amountBeforeEnd", availableType);
  lines.add(recordedLine("owed.walk.opening", opening, { datedBy: "settled" }));
  let moved = ZERO;
  for (const movement of WALK_MOVEMENTS) {
    const signed = ledger.sum("amountP", movement.filter);
    moved += signed;
    lines.add(directedLine(movement.key, movement.usual === "minus" ? -signed : signed, movement.usual, { datedBy: movement.datedBy }));
  }
  const other = ledger.sum("amountP", (group) => UNEXPECTED_TYPES.has(group.type));
  moved += other;
  if (other !== ZERO) lines.add(directedLine("owed.walk.other", other, "plus", { datedBy: "posted" }));
  // Whatever the entries don't explain is shown, never absorbed (check W4 lists it).
  const unexplained = closing - opening - moved;
  if (unexplained !== ZERO) lines.add(directedLine("owed.walk.unexplained", unexplained, "plus", { datedBy: "settled" }));
  lines.add(recordedLine("owed.walk.closing", closing, { datedBy: build.balanceClock, operator: "equals" }));
  const split = endBalances(ledger);
  lines.add(recordedLine("owed.walk.we_owe", split.weOwe, { datedBy: build.balanceClock }));
  lines.add(recordedLine("owed.walk.they_owe", split.theyOwe, { datedBy: build.balanceClock }));
  if (!build.endsNow) {
    lines.add(recordedLine("owed.walk.on_the_way", ledger.sum("amountPendingAtEnd", deposit()), { datedBy: "end_of_period" }));
  }
}

function historyMatchesLine(build: Build): FinanceLine {
  const w1 = sourceOf(build.raw.checks.W1);
  if (!w1.data) return unavailableLine("owed.history_matches", w1.failure, { datedBy: "now" });
  return recordedLine("owed.history_matches", w1.data.difference ?? ZERO, {
    datedBy: "now",
    coverage: { done: w1.data.examined - w1.data.exceptions, total: w1.data.examined },
  });
}

function owedSection(build: Build): FinanceSections["owed"] {
  const wallets = build.walletFigures;
  if (!wallets) return failedSection(build.wallets);
  const now: LineOptions = { datedBy: "now" };
  const lines = new LineSet("owed");
  lines.add(recordedLine("owed.we_owe", wallets.weOwe, { ...now, count: wallets.weOweWallets }));
  lines.add(recordedLine("owed.they_owe", wallets.theyOwe, { ...now, count: wallets.theyOweWallets }));
  lines.add(recordedLine("owed.on_the_way", wallets.onTheWay, { ...now, count: wallets.onTheWayWallets }));
  lines.add(recordedLine("owed.wallets", wallets.wallets, now));
  lines.add(historyMatchesLine(build));
  addWalkLines(lines, build);
  return { status: "ok", lines: lines.sorted() };
}

// ── F. Points ───────────────────────────────────────────────────────────

/** Points given, split by the way the deposit that earned them was paid; any other way is "other". */
const POINTS_GIVEN_BY_RAIL: ReadonlyMap<string, FinanceSectionLineKey<"points">> = new Map([
  ["stripe_ach", "points.given.bank"],
  ["stripe_card", "points.given.card"],
  ["usdc_base", "points.given.usdc"],
]);
const POINTS_GIVEN_PARTS: readonly FinanceSectionLineKey<"points">[] = ["points.given.bank", "points.given.card", "points.given.usdc", "points.given.other"];

function pointsGivenPart(rail: string | null): FinanceSectionLineKey<"points"> {
  return POINTS_GIVEN_BY_RAIL.get(rail ?? "") ?? "points.given.other";
}

const EXPIRY_LINES = [
  { key: "points.expiry.next_30_days", bucket: "next30Days" },
  { key: "points.expiry.days_31_to_90", bucket: "days31To90" },
  { key: "points.expiry.later", bucket: "later" },
  { key: "points.expiry.never", bucket: "never" },
] as const;

function addPointsBalanceLines(lines: LineSet<"points">, build: Build): void {
  const wallets = build.walletFigures;
  const now: LineOptions = { datedBy: "now" };
  if (!wallets) {
    const cause = causeOf(build.wallets);
    lines.add(unavailableLine("points.held_now", cause, now));
    for (const entry of EXPIRY_LINES) lines.add(unavailableLine(entry.key, cause, now));
    return;
  }
  lines.add(recordedLine("points.held_now", wallets.points, now));
  for (const entry of EXPIRY_LINES) {
    lines.add(hasTable(build, "lots")
      ? recordedLine(entry.key, wallets.expiry[entry.bucket], { ...now, everyLineWhenZero: true })
      : unavailableLine(entry.key, TABLE_MISSING, now));
  }
}

function pointsSection(build: Build): FinanceSections["points"] {
  const ledger = build.ledgerView;
  if (!ledger) return failedSection(build.ledger);
  const posted: LineOptions = { datedBy: "posted" };
  const lines = new LineSet("points");
  const opening = ledger.sum("amountBeforeStart", rewardsType);
  const earned = ofType("rewards_earned");
  const given = ledger.sum("amountP", earned);
  const used = -ledger.sum("amountP", ofType("rewards_spent"));
  const expired = -ledger.sum("amountP", ofType("rewards_expired"));
  const takenBack = -ledger.sum("amountP", ofType("rewards_reversed"));
  const givenBack = ledger.sum("amountP", ofType("rewards_reinstated"));
  lines.add(recordedLine("points.opening", opening, posted));
  lines.add(directedLine("points.given", given, "plus", posted));
  for (const part of POINTS_GIVEN_PARTS) {
    const amount = ledger.sum("amountP", (group) => earned(group) && pointsGivenPart(group.rewardsRail) === part);
    if (amount !== ZERO) lines.add(recordedLine(part, amount, posted));
  }
  lines.add(directedLine("points.used", used, "minus", posted));
  lines.add(recordedLine("points.used.billed_value", used, posted));
  lines.add(directedLine("points.expired", expired, "minus", posted));
  lines.add(directedLine("points.taken_back", takenBack, "minus", posted));
  lines.add(directedLine("points.given_back", givenBack, "plus", posted));
  lines.add(recordedLine("points.held", opening + given - used - expired - takenBack + givenBack, { datedBy: build.balanceClock, operator: "equals" }));
  const reversals = ofType("funding_reversal");
  lines.add(recordedLine("points.memo.from_cash", ledger.sum("fromCashP", reversals), {
    ...posted, everyLineWhenZero: true, partialReason: ledger.sum("malformedP", reversals) > ZERO ? "metadata_malformed" : null,
  }));
  addPointsBalanceLines(lines, build);
  lineWorking(lines, "points.held", ["points.opening", "points.given", "points.used", "points.expired", "points.taken_back", "points.given_back"]);
  return { status: "ok", lines: lines.sorted() };
}

// ── G. Insurance pool ───────────────────────────────────────────────────

/** Why the program-wide pool-ledger lines have no number here, if they don't. */
function poolLedgerUnavailable(build: Build): Unavailable | null {
  if (build.vendorView) return PROGRAM_WIDE;
  if (!hasTable(build, "pool_ledger")) return TABLE_MISSING;
  return null;
}

function poolSection(build: Build): FinanceSections["pool"] {
  const pool = build.pool.data;
  if (!pool) return failedSection(build.pool);
  const ledger = build.ledgerView;
  const lines = new LineSet("pool");
  const posted: LineOptions = { datedBy: "posted" };
  const closingClock: LineOptions = { datedBy: build.balanceClock, operator: "equals" };
  const programWide = poolLedgerUnavailable(build);
  const poolCredits = ofType("insurance_pool_credit");

  lines.add(directedLine("pool.set_aside", pool.setAsideP, "plus", { datedBy: "accepted" }));
  if (!ledger) {
    const cause = causeOf(build.ledger);
    lines.add(unavailableLine("pool.paid_out", cause, { ...posted, operator: "minus" }));
    lines.add(unavailableLine("pool.opening", programWide ?? cause, posted));
    lines.add(unavailableLine("pool.closing", programWide ?? cause, closingClock));
  } else {
    const paidOut = ledger.sum("amountP", poolCredits);
    lines.add(directedLine("pool.paid_out", paidOut, "minus", posted));
    for (const kind of POOL_CREDIT_KINDS) {
      const amount = ledger.sum("amountP", (group) => poolCredits(group) && group.referenceType === kind.referenceType);
      if (amount !== ZERO) lines.add(recordedLine(`pool.paid_out.${kind.suffix}`, amount, posted));
    }
    if (programWide) {
      lines.add(unavailableLine("pool.opening", programWide, posted));
      lines.add(unavailableLine("pool.closing", programWide, closingClock));
    } else {
      // Payouts reach vendors' wallets as positive insurance_pool_credit entries; the pool loses them.
      const opening = pool.setAsideBeforeStart - ledger.sum("amountBeforeStart", poolCredits) + pool.toppedUpBeforeStart;
      lines.add(recordedLine("pool.opening", opening, posted));
      lines.add(recordedLine("pool.closing", opening + pool.setAsideP - paidOut + pool.toppedUpP, closingClock));
    }
  }
  lines.add(programWide
    ? unavailableLine("pool.topped_up", programWide, { ...posted, operator: "plus" })
    : directedLine("pool.topped_up", pool.toppedUpP, "plus", posted));
  lines.add(programWide
    ? unavailableLine("pool.record", programWide, { datedBy: build.balanceClock })
    : recordedLine("pool.record", pool.recordedLedgerAtEnd, { datedBy: build.balanceClock }));
  lines.add(hasTable(build, "claims")
    ? recordedLine("pool.claims", sumBig(pool.claims.map((claim) => claim.asked)), { ...posted, count: sumBig(pool.claims.map((claim) => claim.claims)) })
    : unavailableLine("pool.claims", TABLE_MISSING, posted));
  lineWorking(lines, "pool.closing", ["pool.opening", "pool.set_aside", "pool.paid_out", "pool.topped_up"]);
  return { status: "ok", lines: lines.sorted() };
}

// ── H. Vendors ──────────────────────────────────────────────────────────

type VendorFigures = Omit<FinanceVendorAggregateRow, "vendors">;

interface VendorBig {
  readonly row: FinanceRawVendorRow;
  readonly keptOnOrders: bigint;
  readonly kept: bigint;
}

function vendorBig(row: FinanceRawVendorRow): VendorBig {
  const keptOnOrders = row.billedFc - signedMillsToCents(row.cogsMillsFc) - row.labelsFc - row.poolFc;
  return { row, keptOnOrders, kept: keptOnOrders + row.fees - row.creditsCs };
}

interface VendorSums {
  orders: bigint;
  billed: bigint;
  waitingOnCosts: bigint;
  keptOnOrders: bigint;
  feesCharged: bigint;
  returnCreditsPaid: bigint;
  kept: bigint;
  cashIn: bigint;
  creditsToVendor: bigint;
  weOweNow: bigint;
  theyOweNow: bigint;
  onTheWay: bigint;
  pointsHeld: bigint;
}

function sumsOf(vendors: readonly VendorBig[]): VendorSums {
  const sum = (pick: (vendor: VendorBig) => bigint) => sumBig(vendors.map(pick));
  return {
    orders: sum((v) => v.row.orders),
    billed: sum((v) => v.row.billed),
    waitingOnCosts: sum((v) => v.row.waiting),
    keptOnOrders: sum((v) => v.keptOnOrders),
    feesCharged: sum((v) => v.row.fees),
    returnCreditsPaid: sum((v) => v.row.creditsCs),
    kept: sum((v) => v.kept),
    cashIn: sum((v) => v.row.cashIn),
    creditsToVendor: sum((v) => v.row.creditsAll),
    weOweNow: sum((v) => max0(v.row.available ?? ZERO)),
    theyOweNow: sum((v) => max0(-(v.row.available ?? ZERO))),
    onTheWay: sum((v) => v.row.pending ?? ZERO),
    pointsHeld: sum((v) => v.row.points ?? ZERO),
  };
}

function vendorFigures(sums: VendorSums, what: string): VendorFigures {
  return {
    orders: count(sums.orders, what),
    billed: cents(sums.billed, what),
    waitingOnCosts: count(sums.waitingOnCosts, what),
    keptOnOrders: cents(sums.keptOnOrders, what),
    feesCharged: cents(sums.feesCharged, what),
    returnCreditsPaid: cents(sums.returnCreditsPaid, what),
    kept: cents(sums.kept, what),
    cashIn: cents(sums.cashIn, what),
    creditsToVendor: cents(sums.creditsToVendor, what),
    weOweNow: cents(sums.weOweNow, what),
    theyOweNow: cents(sums.theyOweNow, what),
    onTheWay: cents(sums.onTheWay, what),
    pointsHeld: count(sums.pointsHeld, what),
  };
}

function vendorRowOf(vendor: VendorBig): FinanceVendorRow {
  const what = `vendors.${vendor.row.vendorId}`;
  if (vendor.row.status.length > MAX_VENDOR_STATUS) throw new FinanceFigureError(FINANCE_DATA_INVALID_CODE, what);
  return {
    ...financeVendorName(vendor.row.vendorId, vendor.row.businessName, vendor.row.contactName),
    status: vendor.row.status,
    ...vendorFigures(sumsOf([vendor]), what),
  };
}

function byKeptThenId(a: VendorBig, b: VendorBig): number {
  if (a.kept !== b.kept) return a.kept > b.kept ? -1 : 1;
  return a.row.vendorId - b.row.vendorId;
}

function vendorsSection(build: Build): FinanceSections["vendors"] {
  const rows = build.vendors.data;
  const wallets = build.walletFigures;
  const emptyTable = { top: [], others: null, total: null, roundingCents: { keptOnOrders: 0, kept: 0 }, vendorsOrdered: 0, wallets: 0 };
  if (!rows) return { ...failedSection(build.vendors), ...emptyTable };
  try {
    const vendors = rows.map(vendorBig).sort(byKeptThenId);
    const rest = vendors.slice(FINANCE_TOP_ROWS);
    const sums = sumsOf(vendors);
    // The totals row is the page (kept on orders and kept rounded once);
    // the rounding row is what the per-vendor rounding leaves over.
    const pageKeptOnOrders = build.orderFigures?.keptOnOrders ?? sums.keptOnOrders;
    const pageKept = build.kept ?? sums.kept;
    const totalSums = { ...sums, keptOnOrders: pageKeptOnOrders, kept: pageKept };
    const ordered = BigInt(vendors.filter((vendor) => vendor.row.orders > ZERO).length);
    const lines = new LineSet("vendors");
    lines.add(recordedLine("vendors.ordered", ordered, { datedBy: "accepted" }));
    lines.add(wallets
      ? recordedLine("vendors.wallets", wallets.wallets, { datedBy: "now" })
      : unavailableLine("vendors.wallets", causeOf(build.wallets), { datedBy: "now" }));
    return {
      status: "ok",
      lines: lines.sorted(),
      top: vendors.slice(0, FINANCE_TOP_ROWS).map(vendorRowOf),
      others: rest.length > 0 ? { vendors: rest.length, ...vendorFigures(sumsOf(rest), "vendors.others") } : null,
      total: vendors.length > 0 ? { vendors: vendors.length, ...vendorFigures(totalSums, "vendors.total") } : null,
      roundingCents: {
        keptOnOrders: cents(pageKeptOnOrders - sums.keptOnOrders, "vendors.rounding"),
        kept: cents(pageKept - sums.kept, "vendors.rounding"),
      },
      vendorsOrdered: count(ordered, "vendors.ordered"),
      wallets: wallets ? count(wallets.wallets, "vendors.wallets") : 0,
    };
  } catch (error) {
    if (!(error instanceof FinanceFigureError)) throw error;
    return { status: "error", errorCode: error.code, lines: [], ...emptyTable };
  }
}

// ── answer card (spec §3.2) ─────────────────────────────────────────────

function failedAnswer(cause: { status: "error" | "skipped"; errorCode: string }): FinanceAnswer {
  // Placeholders only: the page shows no number of an answer that is not "ok".
  return {
    state: "unavailable",
    status: cause.status,
    errorCode: cause.errorCode,
    kept: { amount: null, status: "unavailable", errorCode: cause.errorCode },
    keptOnOrders: null,
    feesCharged: null,
    returnCreditsPaid: null,
    orders: 0,
    billed: 0,
    fullyCosted: { orders: 0, billed: 0 },
    waiting: { orders: 0, billed: 0 },
    costOfGoods: null,
    carrierLabels: null,
    poolShare: null,
    marginTenths: null,
    marginBps: null,
    priorMarginTenths: null,
    marginChangeTenths: null,
    centsOfEachDollar: null,
    barBps: null,
    paidWithPoints: { billed: 0, points: 0 },
    coverage: { done: 0, total: 0 },
    workings: [],
  };
}

function answerState(figures: OrderFigures, kept: bigint): FinanceAnswer["state"] {
  if (figures.totals.orders === ZERO) return "no_orders";
  if (figures.totals.fcOrders === ZERO) return "not_ready";
  return kept < ZERO ? "loss" : "kept";
}

function priorMargin(build: Build): bigint | null {
  const prior = compareOrderFigures(build);
  if (prior === null || prior === "unavailable") return null;
  return financeShare(prior.keptOnOrders, prior.totals.billedFc).tenths;
}

function billedPartsNumbers(split: FinanceBilledParts | null): NonNullable<FinanceAnswer["centsOfEachDollar"]> | null {
  if (!split) return null;
  return {
    kept: count(split.kept, "answer.split"),
    costOfGoods: count(split.costOfGoods, "answer.split"),
    carrierLabels: count(split.carrierLabels, "answer.split"),
    poolShare: count(split.poolShare, "answer.split"),
  };
}

function barNumbers(split: FinanceBarParts | null): NonNullable<FinanceAnswer["barBps"]> | null {
  const parts = billedPartsNumbers(split);
  return split && parts ? { ...parts, waiting: count(split.waiting, "answer.split") } : null;
}

/** "How this is worked out" for the hero (spec §3.2): the arithmetic with the page's own figures. */
function answerWorkings(build: Build, sales: FinanceSections["sales"]): FinanceWorkingStep[] {
  const line = (key: FinanceSectionLineKey<"sales">) => sales.lines.find((candidate) => candidate.key === key);
  const amountOf = (key: FinanceSectionLineKey<"sales">) => line(key)?.amount ?? null;
  const steps: FinanceWorkingStep[] = [];
  const push = (textKey: string, operands: FinanceWorkingOperand[], result: number | null) =>
    steps.push(stepOf(steps.length + 1, textKey, operands, result));
  const operands = (...keys: FinanceSectionLineKey<"sales">[]) => operandsOf(keys.map(line));
  push("working.two_clocks", [], null);
  push("sales.billed_fc", operands("sales.billed", "sales.waiting"), amountOf("sales.billed_fc"));
  push("sales.kept_orders", operands("sales.billed_fc", "sales.cogs", "sales.labels", "sales.pool_fc"), amountOf("sales.kept_orders"));
  push("working.cogs_basis", [], null);
  push("sales.kept", operands("sales.kept_orders", "sales.fees", "sales.return_credits_cs"), amountOf("sales.kept"));
  // A share, not a sum: both figures are shown as they are, and the margin itself is on the answer.
  const share = (keptOnOrders: number | null, billedFc: number | null): FinanceWorkingOperand[] => [
    { lineKey: "sales.kept_orders", amount: keptOnOrders, unit: "cents", operator: "none" },
    { lineKey: "sales.billed_fc", amount: billedFc, unit: "cents", operator: "none" },
  ];
  push("working.margin_share", share(amountOf("sales.kept_orders"), amountOf("sales.billed_fc")), null);
  const prior = compareOrderFigures(build);
  if (prior !== null && prior !== "unavailable") {
    push("working.margin_prior", share(toSafeNumber(prior.keptOnOrders), toSafeNumber(prior.totals.billedFc)), null);
    push("working.margin_change", [], null);
  }
  push("working.not_included", [], null);
  return steps;
}

function answerOf(build: Build, sales: FinanceSections["sales"]): FinanceAnswer {
  const figures = build.orderFigures;
  const fees = build.fees;
  // The hero needs both the orders and the ledger (contract §2.1 answer.state).
  if (!figures) return failedAnswer(causeOf(build.orders));
  if (!fees || build.kept === null) return failedAnswer(causeOf(build.ledger));
  const t = figures.totals;
  const kept = build.kept;
  try {
    const state = answerState(figures, kept);
    const margin = financeShare(figures.keptOnOrders, t.billedFc);
    const prior = priorMargin(build);
    const keptAmount = toSafeNumber(kept);
    const parts = { kept: figures.keptOnOrders, costOfGoods: figures.costOfGoods, carrierLabels: t.labelsFc, poolShare: t.poolFc };
    // A loss has no "where each $1 went" split; the page draws the loss layout (spec §7).
    const showSplit = state !== "loss";
    return {
      state,
      status: "ok",
      kept: keptAmount === null
        ? { amount: null, status: "unavailable", errorCode: FINANCE_AMOUNT_OUT_OF_RANGE_CODE }
        : { amount: keptAmount, status: fees.partial ? "partial" : "recorded" },
      keptOnOrders: toSafeNumber(figures.keptOnOrders),
      feesCharged: toSafeNumber(fees.total),
      returnCreditsPaid: toSafeNumber(fees.returnCredits),
      orders: count(t.orders, "answer.orders"),
      billed: cents(t.billed, "answer.billed"),
      fullyCosted: { orders: count(t.fcOrders, "answer.fullyCosted"), billed: cents(t.billedFc, "answer.fullyCosted") },
      waiting: { orders: count(figures.waitingOrders, "answer.waiting"), billed: cents(figures.waitingBilled, "answer.waiting") },
      costOfGoods: toSafeNumber(figures.costOfGoods),
      carrierLabels: toSafeNumber(t.labelsFc),
      poolShare: toSafeNumber(t.poolFc),
      marginTenths: nullableCents(margin.tenths),
      marginBps: nullableCents(margin.bps),
      priorMarginTenths: nullableCents(prior),
      marginChangeTenths: margin.tenths !== null && prior !== null ? nullableCents(margin.tenths - prior) : null,
      centsOfEachDollar: showSplit ? billedPartsNumbers(centsOfEachDollar(parts, t.billedFc)) : null,
      barBps: showSplit ? barNumbers(barWidths({ ...parts, waiting: figures.waitingBilled }, t.billed)) : null,
      paidWithPoints: { billed: cents(t.paidPoints, "answer.paidWithPoints"), points: count(t.paidPoints, "answer.paidWithPoints") },
      coverage: { done: count(t.fcOrders, "answer.coverage"), total: count(t.orders, "answer.coverage") },
      workings: answerWorkings(build, sales),
    };
  } catch (error) {
    if (!(error instanceof FinanceFigureError)) throw error;
    return failedAnswer({ status: "error", errorCode: error.code });
  }
}

// ── tiles (spec §3.3) ───────────────────────────────────────────────────

function unavailableFigure(cause: { errorCode: string }): FinanceFigure {
  return { amount: null, status: "unavailable", errorCode: cause.errorCode };
}

function figureOf(value: bigint, partial: boolean): FinanceFigure {
  const amount = toSafeNumber(value);
  if (amount === null) return { amount: null, status: "unavailable", errorCode: FINANCE_AMOUNT_OUT_OF_RANGE_CODE };
  return { amount, status: partial ? "partial" : "recorded" };
}

function safeCountOr0(value: bigint): number {
  const number = toSafeNumber(value);
  return number === null || number < 0 ? 0 : number;
}

function tilesOf(build: Build): FinanceTiles {
  const figures = build.orderFigures;
  const cash = build.cash;
  const wallets = build.walletFigures;
  const atEnd = !build.endsNow && build.ledgerView ? endBalances(build.ledgerView) : null;
  return {
    billed: figures
      ? { ...figureOf(figures.totals.billed, false), orders: safeCountOr0(figures.totals.orders), prior: billedPrior(build) }
      : { ...unavailableFigure(causeOf(build.orders)), orders: 0, prior: null },
    cashReceived: cash && cash.received !== null
      ? { ...figureOf(cash.received, cash.receivedPartialReason !== null), prior: cashPrior(build) }
      : { ...unavailableFigure(build.ledger.failure ?? causeOf(build.disputes)), prior: null },
    weOweNow: wallets
      ? { ...figureOf(wallets.weOwe, false), vendors: safeCountOr0(wallets.weOweWallets), onTheWay: toSafeNumber(wallets.onTheWay), atEndOfPeriod: atEnd ? toSafeNumber(atEnd.weOwe) : null }
      : { ...unavailableFigure(causeOf(build.wallets)), vendors: 0, onTheWay: null, atEndOfPeriod: null },
    owedToUsNow: wallets
      ? { ...figureOf(wallets.theyOwe, false), vendors: safeCountOr0(wallets.theyOweWallets), atEndOfPeriod: atEnd ? toSafeNumber(atEnd.theyOwe) : null }
      : { ...unavailableFigure(causeOf(build.wallets)), vendors: 0, atEndOfPeriod: null },
  };
}

// ── checks (spec §8, contract §3) ───────────────────────────────────────

function checkFrom(id: FinanceCheckId, result: FinanceRawResult<FinanceRawCheckCounts> | undefined): FinanceCheck {
  const definition = FINANCE_CHECK_DEFINITIONS[id];
  const base = { id, group: definition.group, scope: definition.scope, ownerLineKeys: [...definition.ownerLineKeys] };
  const couldNotCheck = (errorCode: string): FinanceCheck => ({ ...base, result: "could_not_check", examined: 0, exceptions: 0, difference: null, errorCode });
  if (!result) return couldNotCheck(FINANCE_INTERNAL_ERROR_CODE);
  if (result.status !== "ok") return couldNotCheck(result.errorCode);
  const examined = toSafeNumber(result.data.examined);
  const exceptions = toSafeNumber(result.data.exceptions);
  if (examined === null || exceptions === null || examined < 0 || exceptions < 0) return couldNotCheck(FINANCE_AMOUNT_OUT_OF_RANGE_CODE);
  return {
    ...base,
    result: exceptions > 0 ? "needs_a_look" : "fine",
    examined,
    exceptions,
    difference: result.data.difference === null ? null : toSafeNumber(abs(result.data.difference)),
  };
}

function programWideCheck(id: FinanceCheckId): FinanceCheck {
  const definition = FINANCE_CHECK_DEFINITIONS[id];
  return {
    id, group: definition.group, scope: definition.scope, ownerLineKeys: [...definition.ownerLineKeys],
    result: "program_wide", examined: 0, exceptions: 0, difference: null,
  };
}

/** P2: every table the page reads exists (Q0). */
function tablesCheck(build: Build): FinanceRawResult<FinanceRawCheckCounts> {
  const missing = FINANCE_TABLES.filter((table) => !hasTable(build, table.key)).length;
  return { status: "ok", data: { examined: BigInt(FINANCE_TABLES.length), exceptions: BigInt(missing), difference: null } };
}

/** P1: the page's identities over the summary built so far. */
function identitiesCheck(build: Build, answer: FinanceAnswer, tiles: FinanceTiles, sections: FinanceSections): FinanceRawResult<FinanceRawCheckCounts> {
  const report = checkSummaryIdentities({ answer, tiles, sections, endsNow: build.endsNow });
  const moneyExceptions = report.exceptions.filter((item) => item.unit !== "count");
  return {
    status: "ok",
    data: {
      examined: BigInt(report.examined.length),
      exceptions: BigInt(report.exceptions.length),
      difference: moneyExceptions.length > 0 ? sumBig(moneyExceptions.map((item) => abs(item.found - item.expected))) : null,
    },
  };
}

function checksOf(build: Build, answer: FinanceAnswer, tiles: FinanceTiles, sections: FinanceSections): FinanceCheck[] {
  return FINANCE_CHECK_IDS.map((id) => {
    if (build.vendorView && FINANCE_CHECK_DEFINITIONS[id].programOnly) return programWideCheck(id);
    if (id === "P1") return checkFrom(id, identitiesCheck(build, answer, tiles, sections));
    if (id === "P2") return checkFrom(id, tablesCheck(build));
    return checkFrom(id, build.raw.checks[id]);
  });
}

// ── information lines (spec §8) ─────────────────────────────────────────

function infoLine(key: FinanceLineKey, value: bigint, datedBy: FinanceDatedBy, operator: FinanceOperator = "none"): FinanceLine {
  return recordedLine(key, value, { datedBy, operator });
}

function wonDisputesInfo(build: Build): FinanceInfoLine | null {
  const disputes = build.disputes.data;
  if (!disputes) return null;
  const wins = disputes.won.filter((win) => win.inP);
  if (wins.length === 0) return null;
  const complete = wins.every((win) => win.reversalId !== null && win.disputedCents !== null && win.creditCents !== null);
  const disputed = sumBig(wins.map((win) => win.disputedCents ?? ZERO));
  const cardFeePart = sumBig(wins.map((win) =>
    win.disputedCents !== null && win.creditCents !== null ? max0(win.disputedCents - win.creditCents) : ZERO));
  return {
    key: "won_disputes",
    status: complete ? "recorded" : "partial",
    lines: [
      infoLine("info.won_disputes.cash_returned", disputed, "posted"),
      infoLine("info.won_disputes.wallet_restored", sumBig(wins.map((win) => win.restoredCents)), "posted"),
      infoLine("info.won_disputes.card_fee_part", cardFeePart, "posted"),
      infoLine("info.won_disputes.points_from_cash", sumBig(wins.map((win) => win.fromCashCents ?? ZERO)), "posted"),
    ],
  };
}

function poolRecordInfo(build: Build, pool: FinanceSections["pool"]): FinanceInfoLine | null {
  if (build.vendorView || !build.pool.data || pool.status !== "ok") return null;
  const record = pool.lines.find((line) => line.key === "pool.record");
  const closing = pool.lines.find((line) => line.key === "pool.closing");
  if (!record || !closing || record.amount === null || closing.amount === null) return null;
  return {
    key: "pool_record",
    status: "recorded",
    lines: [
      infoLine("info.pool_record.recorded", BigInt(record.amount), build.balanceClock),
      infoLine("info.pool_record.worked_out", BigInt(closing.amount), build.balanceClock),
    ],
  };
}

const BRIDGE_KEYS = [
  "info.overview_bridge.oms_row",
  "info.overview_bridge.billed",
  "info.overview_bridge.leftover_pending",
  "info.overview_bridge.cancelled_in_oms",
  "info.overview_bridge.date_basis",
] as const;

/**
 * The Overview dashboard's Dropship row against billed here (recon 10):
 * OMS row − billed = leftover pending + cancelled in OMS (negative: billed
 * here, left out there) + date basis, which closes by construction.
 */
function overviewBridgeInfo(build: Build): FinanceInfoLine | null {
  if (build.vendorView || build.raw.bridge === null) return null;
  const bridge = sourceOf(build.raw.bridge);
  const figures = build.orderFigures;
  if (!bridge.data || !figures) {
    const cause = bridge.failure ?? causeOf(build.orders);
    return { key: "overview_bridge", status: "unavailable", lines: BRIDGE_KEYS.map((key) => unavailableLine(key, cause, { datedBy: "accepted" })) };
  }
  const billed = figures.totals.billed;
  const cancelled = build.orders.data?.byReason.find((row) => row.reason === "cancelled_in_oms")?.billed ?? ZERO;
  const dateBasis = bridge.data.omsRow - bridge.data.notAccepted - (billed - cancelled);
  return {
    key: "overview_bridge",
    status: "recorded",
    lines: [
      infoLine("info.overview_bridge.oms_row", bridge.data.omsRow, "accepted"),
      infoLine("info.overview_bridge.billed", billed, "accepted"),
      infoLine("info.overview_bridge.leftover_pending", bridge.data.notAccepted, "accepted"),
      infoLine("info.overview_bridge.cancelled_in_oms", -cancelled, "accepted"),
      infoLine("info.overview_bridge.date_basis", dateBasis, "accepted"),
    ],
  };
}

// ── the summary ─────────────────────────────────────────────────────────

/**
 * Builds the Program finance summary from one snapshot's raw aggregates,
 * and validates it against the shared contract. Throws
 * DROPSHIP_FINANCE_INTERNAL_ERROR when the raw bounds disagree with the
 * context's windows, and DROPSHIP_FINANCE_CONTRACT_VIOLATION (with issue
 * paths only, no values) when the result would break the contract.
 */
export function buildFinanceSummary(raw: FinanceRawAggregates, context: FinanceSummaryContext): FinanceSummary {
  assertBoundsMatch(raw, context);
  const build = startBuild(raw, context);
  const sections: FinanceSections = {
    sales: salesSection(build),
    products: productsSection(build),
    cash: cashSection(build),
    returns: returnsSection(build),
    owed: owedSection(build),
    points: pointsSection(build),
    pool: poolSection(build),
    vendors: vendorsSection(build),
  };
  const answer = answerOf(build, sections.sales);
  const tiles = tilesOf(build);
  const info = [overviewBridgeInfo(build), poolRecordInfo(build, sections.pool), wonDisputesInfo(build)]
    .filter((line): line is FinanceInfoLine => line !== null);
  const summary: FinanceSummaryInput = {
    contractVersion: FINANCE_CONTRACT_VERSION,
    generatedAt: new Date(context.generatedAt.getTime()),
    timeZone: FINANCE_TIME_ZONE,
    scope: { vendor: context.vendor },
    period: toFinanceWindow(context.period),
    comparePeriod: context.comparePeriod ? toFinanceWindow(context.comparePeriod) : null,
    answer,
    tiles,
    sections,
    checks: checksOf(build, answer, tiles, sections),
    info,
    notes: financePolicyEraNotes(context.period),
  };
  const parsed = financeSummarySchema.safeParse(summary);
  if (!parsed.success) {
    throw new DropshipError(FINANCE_CONTRACT_VIOLATION_CODE, "The finance summary does not match its contract.", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return parsed.data;
}

// ── diagnostics for the service's log lines ─────────────────────────────

export interface FinanceSummaryDiagnostics {
  readonly sectionStatuses: Readonly<Record<FinanceSectionKey | "answer", FinanceSummary["answer"]["status"]>>;
  readonly checksNeedingLook: readonly FinanceCheckId[];
  readonly checksNotRun: readonly { readonly id: FinanceCheckId; readonly errorCode: string | undefined }[];
  /** Paths of every figure withheld as DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE (log at ERROR). */
  readonly outOfRange: readonly string[];
}

/**
 * What the service logs about a built summary (contract §3, §5): section
 * statuses and the checks that need a look (one INFO line), and every
 * figure withheld as out of range (ERROR each). No money values.
 */
export function financeSummaryDiagnostics(summary: FinanceSummary): FinanceSummaryDiagnostics {
  const outOfRange: string[] = [];
  const statuses = { answer: summary.answer.status } as Record<FinanceSectionKey | "answer", FinanceSummary["answer"]["status"]>;
  if (summary.answer.errorCode === FINANCE_AMOUNT_OUT_OF_RANGE_CODE) outOfRange.push("answer");
  if (summary.answer.kept.errorCode === FINANCE_AMOUNT_OUT_OF_RANGE_CODE) outOfRange.push("answer.kept");
  for (const [tile, figure] of Object.entries(summary.tiles)) {
    if (figure.errorCode === FINANCE_AMOUNT_OUT_OF_RANGE_CODE) outOfRange.push(`tiles.${tile}`);
  }
  for (const section of FINANCE_SECTION_KEYS) {
    const value = summary.sections[section];
    statuses[section] = value.status;
    if (value.errorCode === FINANCE_AMOUNT_OUT_OF_RANGE_CODE) outOfRange.push(`sections.${section}`);
    for (const line of value.lines) if (line.errorCode === FINANCE_AMOUNT_OUT_OF_RANGE_CODE) outOfRange.push(line.key);
  }
  for (const info of summary.info) {
    for (const line of info.lines) if (line.errorCode === FINANCE_AMOUNT_OUT_OF_RANGE_CODE) outOfRange.push(line.key);
  }
  return {
    sectionStatuses: statuses,
    checksNeedingLook: summary.checks.filter((check) => check.result === "needs_a_look").map((check) => check.id),
    checksNotRun: summary.checks.filter((check) => check.result === "could_not_check").map((check) => ({ id: check.id, errorCode: check.errorCode })),
    outOfRange,
  };
}
