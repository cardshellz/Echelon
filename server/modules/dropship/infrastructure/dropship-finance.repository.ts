/**
 * The Program finance read model (contract §1.1, §2, §3): runs the summary
 * statements of dropship-finance-sql.ts in one REPEATABLE READ READ ONLY
 * snapshot and maps every row into the raw aggregates the pure builder takes
 * (domain/program-finance-raw.ts).
 *
 * Mapping is strict: int8 and numeric arrive as decimal text and are parsed
 * with parseIntegerString into BigInt; a value that is not integer text
 * fails its section with DROPSHIP_FINANCE_DATA_INVALID instead of turning
 * into a wrong number. Safe-integer limits are the builder's concern, so a
 * huge but exact sum is still passed through as BigInt.
 *
 * At most FINANCE_MAX_CONCURRENT_REQUESTS snapshots run at once in this
 * process: the pool is shared with webhooks (contract C13). A request that
 * cannot get a slot within FINANCE_BUSY_WAIT_MS is refused as
 * DROPSHIP_FINANCE_BUSY (503, transient).
 */

import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import {
  FINANCE_COST_WAIT_ALERT_DAYS,
  FINANCE_NEVER_CHARGED_KINDS,
  FINANCE_WAITING_REASONS,
  type FinanceNeverChargedKind,
  type FinanceWaitingReason,
} from "../../../../shared/dropship/program-finance";
import { parseIntegerString } from "../../../../shared/dropship/program-finance-money";
import type {
  DropshipFinanceRepository,
  FinanceSummaryRead,
  FinanceSummaryReadRequest,
  FinanceVendorRecord,
} from "../application/dropship-finance-service";
import { FINANCE_VENDOR_NOT_FOUND_CODE } from "../application/dropship-finance-service";
import { DropshipError } from "../domain/errors";
import {
  FINANCE_TABLES,
  type FinanceCashLine,
  type FinanceRawAggregates,
  type FinanceRawBounds,
  type FinanceRawBridge,
  type FinanceRawCheckCounts,
  type FinanceRawChecks,
  type FinanceRawDisputes,
  type FinanceRawLedger,
  type FinanceRawLedgerGroup,
  type FinanceRawNeverChargedRow,
  type FinanceRawOrderTotals,
  type FinanceRawOrders,
  type FinanceRawPool,
  type FinanceRawProductGroupRow,
  type FinanceRawProducts,
  type FinanceRawResult,
  type FinanceRawReturnFeeRow,
  type FinanceRawTables,
  type FinanceRawVendorRow,
  type FinanceRawWallet,
  type FinanceRawWonDispute,
  type FinanceSqlCheckId,
  type FinanceTableKey,
} from "../domain/program-finance-raw";
import {
  FINANCE_DATA_INVALID_SQL_CODE,
  FINANCE_TABLE_MISSING_SQL_CODE,
  FinanceRowError,
  withFinanceReadTransaction,
  type FinanceBudgetClock,
  type FinanceQueryRunner,
  type FinanceReadTransaction,
} from "./dropship-finance-read-transaction";
import {
  FINANCE_CHECK_SQL,
  FINANCE_FIRST_FAILURE_CODE,
  FINANCE_ISO_MINUS_INFINITY,
  FINANCE_ISO_PLUS_INFINITY,
  FINANCE_LEDGER_GROUPS,
  FINANCE_NOT_WON_BACK,
  FINANCE_OVERVIEW_BRIDGE,
  FINANCE_POOL_CLAIMS,
  FINANCE_Q0,
  FINANCE_SECTION_REQUIRES,
  FINANCE_VENDOR_LOOKUP,
  FINANCE_WON_DISPUTES,
  checkCountsSql,
  neverChargedStatement,
  ordersStatement,
  poolStatement,
  productsStatement,
  returnFeesStatement,
  vendorsStatement,
  walletsStatement,
  type FinanceCheckSql,
  type FinanceSqlFlags,
  type FinanceSqlParam,
  type FinanceSqlStatement,
} from "./dropship-finance-sql";

/** Finance snapshots one process runs at once (contract C13). */
export const FINANCE_MAX_CONCURRENT_REQUESTS = 2;
/** How long a request waits for a slot before it is refused as busy. */
export const FINANCE_BUSY_WAIT_MS = 2_000;
export const FINANCE_BUSY_CODE = "DROPSHIP_FINANCE_BUSY";

const MS_PER_DAY = 24 * 60 * 60 * 1_000;
/** Q0 reports an open upper bound as this text (contract C6). */
const OPEN_END_BOUND = "infinity";
const OPEN_START_BOUND = "-infinity";

// ── semaphore (contract C13) ────────────────────────────────────────────

/** A counting semaphore with a bounded wait; a waiter that times out is refused, never queued forever. */
export class FinanceRequestSemaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("FinanceRequestSemaphore needs a positive limit.");
  }

  /** Resolves with a release function, or rejects with DROPSHIP_FINANCE_BUSY after `waitMs`. */
  acquire(waitMs: number): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(this.releaser());
      };
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(grant);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new DropshipError(FINANCE_BUSY_CODE, "The finance page is busy; try again in a moment.", {
          limit: this.limit,
          waitedMs: waitMs,
        }));
      }, waitMs);
      this.waiting.push(grant);
    });
  }

  /** Requests holding a slot now (tests and diagnostics). */
  inUse(): number {
    return this.active;
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // A waiting request takes the slot over; otherwise the slot frees up.
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    };
  }
}

/** One semaphore per process, shared by every repository instance. */
const PROCESS_FINANCE_SEMAPHORE = new FinanceRequestSemaphore(FINANCE_MAX_CONCURRENT_REQUESTS);

export interface PgDropshipFinanceRepositoryOptions {
  /** The request-budget clock; defaults to the system clock. */
  readonly clock?: FinanceBudgetClock;
  readonly semaphore?: FinanceRequestSemaphore;
  readonly busyWaitMs?: number;
  /** Defaults to FINANCE_REQUEST_BUDGET_MS. */
  readonly budgetMs?: number;
}

const systemBudgetClock: FinanceBudgetClock = { now: () => new Date() };

// ── row reading ─────────────────────────────────────────────────────────

type Row = Readonly<Record<string, unknown>>;

/** A SUM or COUNT: SQL NULL is "no row matched", a true zero (program-finance-raw.ts NULL rules). */
function big(row: Row, column: string): bigint {
  return bigOrNull(row, column) ?? BigInt(0);
}

/** An amount that may be "not known" (NULL kept). */
function bigOrNull(row: Row, column: string): bigint | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const parsed = parseIntegerString(value);
    if (parsed === null) throw new FinanceRowError(FINANCE_DATA_INVALID_SQL_CODE, column);
    return parsed;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "bigint") return value;
  throw new FinanceRowError(FINANCE_DATA_INVALID_SQL_CODE, column);
}

/** An integer id column (int4 arrives as a JS number). */
function id(row: Row, column: string): number {
  const value = idOrNull(row, column);
  if (value === null) throw new FinanceRowError(FINANCE_DATA_INVALID_SQL_CODE, column);
  return value;
}

function idOrNull(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d{1,15}$/.test(value)) return Number(value);
  throw new FinanceRowError(FINANCE_DATA_INVALID_SQL_CODE, column);
}

function text(row: Row, column: string): string {
  const value = textOrNull(row, column);
  if (value === null) throw new FinanceRowError(FINANCE_DATA_INVALID_SQL_CODE, column);
  return value;
}

function textOrNull(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  throw new FinanceRowError(FINANCE_DATA_INVALID_SQL_CODE, column);
}

function boolOrNull(row: Row, column: string): boolean | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  throw new FinanceRowError(FINANCE_DATA_INVALID_SQL_CODE, column);
}

function bool(row: Row, column: string): boolean {
  const value = boolOrNull(row, column);
  if (value === null) throw new FinanceRowError(FINANCE_DATA_INVALID_SQL_CODE, column);
  return value;
}

function instantOrNull(row: Row, column: string): Date | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  throw new FinanceRowError(FINANCE_DATA_INVALID_SQL_CODE, column);
}

function oneOf<T extends string>(row: Row, column: string, allowed: readonly T[]): T {
  const value = text(row, column);
  if (!(allowed as readonly string[]).includes(value)) throw new FinanceRowError(FINANCE_DATA_INVALID_SQL_CODE, column);
  return value as T;
}

const CASH_LINES: readonly FinanceCashLine[] = ["stripe_ach", "stripe_card", "usdc_base", "manual", "collection", "unknown"];

// ── Q0 ──────────────────────────────────────────────────────────────────

interface SnapshotFrame {
  readonly tables: FinanceRawTables;
  readonly bounds: FinanceRawBounds;
  readonly values: Readonly<Record<FinanceSqlParam, unknown>>;
  readonly endsNow: boolean;
}

function frameFromQ0(row: Row | undefined, request: FinanceSummaryReadRequest): SnapshotFrame {
  if (!row) throw new DropshipError("DROPSHIP_FINANCE_INTERNAL_ERROR", "The finance bounds statement returned no row.");
  const tables = Object.fromEntries(FINANCE_TABLES.map((table) => [table.key, bool(row, `t_${table.key}`)])) as FinanceRawTables;
  const endAt = instantOrNull(row, "end_at");
  if (!endAt) throw new FinanceRowError(FINANCE_DATA_INVALID_SQL_CODE, "end_at");
  const bounds: FinanceRawBounds = {
    startAt: instantOrNull(row, "start_at"),
    endAt,
    compareStartAt: instantOrNull(row, "cmp_start_at"),
    compareEndAt: instantOrNull(row, "cmp_end_at"),
  };
  const startBound = text(row, "start_bound");
  const endBound = text(row, "end_bound");
  const endsNow = endBound === OPEN_END_BOUND;
  const period = request.period;
  const values: Record<FinanceSqlParam, unknown> = {
    startLocal: period.startLocal,
    endLocal: period.endLocal,
    cmpStartLocal: request.comparePeriod?.startLocal ?? null,
    cmpEndLocal: request.comparePeriod?.endLocal ?? null,
    now: request.now.toISOString(),
    startBound,
    endBound,
    cmpStartBound: textOrNull(row, "cmp_start_bound"),
    cmpEndBound: textOrNull(row, "cmp_end_bound"),
    vendorId: request.vendorId,
    // The summary is never scoped to one order; part 2's order record is.
    intakeId: null,
    startIso: bounds.startAt ? bounds.startAt.toISOString() : FINANCE_ISO_MINUS_INFINITY,
    endIso: endsNow ? FINANCE_ISO_PLUS_INFINITY : endAt.toISOString(),
    // OMS ordered_at is naive Eastern wall clock (Q9).
    omsStart: period.startLocal,
    omsEnd: endsNow ? OPEN_END_BOUND : period.endLocal,
  };
  return { tables, bounds, values, endsNow };
}

function valuesFor(statement: FinanceSqlStatement, values: Readonly<Record<FinanceSqlParam, unknown>>): unknown[] {
  return statement.params.map((param) => values[param]);
}

// ── section mappers ─────────────────────────────────────────────────────

function orderTotals(row: Row | undefined): FinanceRawOrderTotals {
  // The grand-total row always comes back (grouping set ()); a missing one reads as an empty window.
  const r: Row = row ?? {};
  return {
    orders: big(r, "orders"),
    fcOrders: big(r, "fc_orders"),
    billed: big(r, "billed"),
    billedFc: big(r, "billed_fc"),
    productBilled: big(r, "product_billed"),
    productBilledFc: big(r, "product_billed_fc"),
    shippingBilled: big(r, "shipping_billed"),
    shippingNetPoolFc: big(r, "shipping_net_pool_fc"),
    quoteBase: big(r, "quote_base"),
    quoteMarkup: big(r, "quote_markup"),
    quoteDunnage: big(r, "quote_dunnage"),
    ordersWithoutQuote: big(r, "orders_without_quote"),
    poolAll: big(r, "pool_all"),
    poolFc: big(r, "pool_fc"),
    paidCash: big(r, "paid_cash"),
    paidPoints: big(r, "paid_points"),
    cogsMillsFc: big(r, "cogs_mills_fc"),
    labelsFc: big(r, "labels_fc"),
    replacementLabelsFc: big(r, "replacement_labels_fc"),
    coverageLabels: big(r, "cov_labels"),
    coverageLabelsCosted: big(r, "cov_labels_costed"),
    buyerPaid: big(r, "buyer_paid"),
    buyerUnknown: big(r, "buyer_unknown"),
  };
}

export function mapOrders(rows: readonly Row[]): FinanceRawOrders {
  const total = rows.find((row) => bool(row, "is_total"));
  const byReason = rows
    .filter((row) => !bool(row, "is_total") && row.waiting_reason !== null && row.waiting_reason !== undefined)
    .map((row) => ({
      reason: oneOf<FinanceWaitingReason>(row, "waiting_reason", FINANCE_WAITING_REASONS),
      orders: big(row, "orders"),
      billed: big(row, "billed"),
    }));
  return { totals: orderTotals(total), byReason };
}

function productFigures(row: Row) {
  return {
    packs: big(row, "packs"),
    pieces: bigOrNull(row, "pieces"),
    linesWithoutPieces: big(row, "lines_without_pieces"),
    packsShipped: big(row, "packs_shipped"),
    packsFc: big(row, "packs_fc"),
    billedProduct: big(row, "billed_product"),
    billedProductFc: big(row, "billed_product_fc"),
    cogsMillsFc: big(row, "cogs_mills_fc"),
  };
}

export function mapProducts(rows: readonly Row[]): FinanceRawProducts {
  const total = rows.find((row) => bool(row, "is_total")) ?? {};
  const groups: FinanceRawProductGroupRow[] = rows
    .filter((row) => !bool(row, "is_total"))
    .map((row) => ({
      groupKey: text(row, "group_key"),
      productVariantId: idOrNull(row, "product_variant_id"),
      productId: idOrNull(row, "product_id"),
      productName: textOrNull(row, "product_name"),
      sizeName: textOrNull(row, "size_name"),
      sku: textOrNull(row, "sku"),
      unitsPerVariant: bigOrNull(row, "units_per_variant"),
      ...productFigures(row),
    }));
  return {
    totals: { ...productFigures(total), unlinkedCogsMillsFc: big(total, "unlinked_cogs_mills_fc") },
    groups,
  };
}

export function mapNeverCharged(rows: readonly Row[]): FinanceRawNeverChargedRow[] {
  return rows.map((row) => ({
    kind: oneOf<FinanceNeverChargedKind>(row, "kind", FINANCE_NEVER_CHARGED_KINDS),
    orders: big(row, "orders"),
    buyerTotal: big(row, "buyer_total"),
    buyerUnknown: big(row, "buyer_unknown"),
    wouldHaveCharged: bigOrNull(row, "would_have_charged"),
  }));
}

function cashLineOf(row: Row): FinanceCashLine | null {
  if (row.cash_line === null || row.cash_line === undefined) return null;
  return oneOf(row, "cash_line", CASH_LINES);
}

export function mapLedgerGroups(rows: readonly Row[]): FinanceRawLedgerGroup[] {
  return rows.map((row) => ({
    vendorId: id(row, "vendor_id"),
    type: text(row, "type"),
    status: text(row, "status"),
    referenceType: textOrNull(row, "reference_type"),
    cashLine: cashLineOf(row),
    rewardsRail: textOrNull(row, "rewards_rail"),
    autoReload: boolOrNull(row, "auto_reload"),
    autoReloadReason: textOrNull(row, "auto_reload_reason"),
    chainWatcher: boolOrNull(row, "chain_watcher"),
    nP: big(row, "n_p"),
    amountP: big(row, "amount_p"),
    chargedP: big(row, "charged_p"),
    cardFeeP: big(row, "card_fee_p"),
    disputeP: big(row, "dispute_p"),
    disputeMissingP: big(row, "dispute_missing_p"),
    fromCashP: big(row, "from_cash_p"),
    malformedP: big(row, "malformed_p"),
    nCmp: big(row, "n_cmp"),
    amountCmp: big(row, "amount_cmp"),
    chargedCmp: big(row, "charged_cmp"),
    disputeCmp: big(row, "dispute_cmp"),
    amountBeforeStart: big(row, "amount_before_start"),
    amountBeforeEnd: big(row, "amount_before_end"),
    nPendingNow: big(row, "n_pending_now"),
    amountPendingNow: big(row, "amount_pending_now"),
    nStale: big(row, "n_stale"),
    amountStale: big(row, "amount_stale"),
    amountPendingAtEnd: big(row, "amount_pending_at_end"),
    nFailedP: big(row, "n_failed_p"),
    amountFailedP: big(row, "amount_failed_p"),
    failedWithoutTime: big(row, "failed_without_time"),
  }));
}

export function mapWonDisputes(rows: readonly Row[]): FinanceRawWonDispute[] {
  return rows.map((row) => ({
    inP: bool(row, "in_p"),
    inCompare: bool(row, "in_cmp"),
    reinstatedId: id(row, "reinstated_id"),
    restoredCents: big(row, "restored_cents"),
    reversalId: idOrNull(row, "reversal_id"),
    disputedCents: bigOrNull(row, "disputed_cents"),
    creditCents: bigOrNull(row, "credit_cents"),
    fromCashCents: bigOrNull(row, "from_cash_cents"),
  }));
}

export function mapReturnFees(rows: readonly Row[]): FinanceRawReturnFeeRow[] {
  return rows.map((row) => ({
    referenceType: textOrNull(row, "reference_type"),
    feeRows: big(row, "fee_rows"),
    feeCents: big(row, "fee_cents"),
    restocking: big(row, "restocking"),
    processing: big(row, "processing"),
    returnLabel: big(row, "return_label"),
    splitNotRecorded: big(row, "split_not_recorded"),
  }));
}

export function mapWallets(rows: readonly Row[]): FinanceRawWallet[] {
  return rows.map((row) => ({
    walletId: id(row, "wallet_id"),
    vendorId: id(row, "vendor_id"),
    available: big(row, "available"),
    pending: big(row, "pending"),
    points: big(row, "points"),
    expiresNext30Days: big(row, "exp_30"),
    expiresDays31To90: big(row, "exp_90"),
    expiresLater: big(row, "exp_later"),
    neverExpires: big(row, "never"),
  }));
}

export function mapVendors(rows: readonly Row[]): FinanceRawVendorRow[] {
  return rows.map((row) => ({
    vendorId: id(row, "vendor_id"),
    businessName: textOrNull(row, "business_name"),
    contactName: textOrNull(row, "contact_name"),
    status: text(row, "status"),
    orders: big(row, "orders"),
    billed: big(row, "billed"),
    waiting: big(row, "waiting"),
    billedFc: big(row, "billed_fc"),
    cogsMillsFc: big(row, "cogs_mills_fc"),
    labelsFc: big(row, "labels_fc"),
    poolFc: big(row, "pool_fc"),
    fees: big(row, "fees"),
    creditsCs: big(row, "credits_cs"),
    creditsAll: big(row, "credits_all"),
    cashIn: big(row, "cash_in"),
    // No wallet: all three stay null, so the builder can tell "none" from 0.
    available: bigOrNull(row, "available"),
    pending: bigOrNull(row, "pending"),
    points: bigOrNull(row, "points"),
  }));
}

export function mapCheckCounts(rows: readonly Row[]): FinanceRawCheckCounts {
  const row = rows[0];
  if (!row) throw new FinanceRowError(FINANCE_DATA_INVALID_SQL_CODE, "examined");
  return { examined: big(row, "examined"), exceptions: big(row, "exceptions"), difference: bigOrNull(row, "difference") };
}

// ── the repository ──────────────────────────────────────────────────────

export class PgDropshipFinanceRepository implements DropshipFinanceRepository {
  private readonly clock: FinanceBudgetClock;
  private readonly semaphore: FinanceRequestSemaphore;
  private readonly busyWaitMs: number;
  private readonly budgetMs: number | undefined;

  constructor(
    private readonly dbPool: Pick<Pool, "connect"> = defaultPool,
    options: PgDropshipFinanceRepositoryOptions = {},
  ) {
    this.clock = options.clock ?? systemBudgetClock;
    this.semaphore = options.semaphore ?? PROCESS_FINANCE_SEMAPHORE;
    this.busyWaitMs = options.busyWaitMs ?? FINANCE_BUSY_WAIT_MS;
    this.budgetMs = options.budgetMs;
  }

  async readSummary(request: FinanceSummaryReadRequest): Promise<FinanceSummaryRead> {
    // The request budget starts here, before the waits for a slot and a pooled client (contract §1.1).
    const startedAtMs = this.clock.now().getTime();
    const release = await this.semaphore.acquire(this.busyWaitMs);
    try {
      return await withFinanceReadTransaction(
        this.dbPool,
        { clock: this.clock, startedAtMs, ...(this.budgetMs !== undefined ? { budgetMs: this.budgetMs } : {}) },
        (transaction) => readSnapshot(transaction, request),
      );
    } finally {
      release();
    }
  }
}

async function readSnapshot(transaction: FinanceReadTransaction, request: FinanceSummaryReadRequest): Promise<FinanceSummaryRead> {
  const q0Rows = await transaction.query<Row>(FINANCE_Q0.text, valuesFor(FINANCE_Q0, {
    startLocal: request.period.startLocal,
    endLocal: request.period.endLocal,
    now: request.now.toISOString(),
    cmpStartLocal: request.comparePeriod?.startLocal ?? null,
    cmpEndLocal: request.comparePeriod?.endLocal ?? null,
  } as Record<FinanceSqlParam, unknown>));
  const frame = frameFromQ0(q0Rows[0], request);
  const vendor = request.vendorId === null ? null : await lookUpVendor(transaction, frame, request.vendorId);
  const sections = new SectionRunner(transaction, frame);
  const flags: FinanceSqlFlags = { tables: frame.tables, endsNow: frame.endsNow };
  const programView = request.vendorId === null;
  const compareValues = { ...frame.values, startBound: frame.values.cmpStartBound, endBound: frame.values.cmpEndBound };

  const orders = await sections.run("orders", FINANCE_SECTION_REQUIRES.orders, ordersStatement(frame.tables), mapOrders);
  const compareOrders = request.comparePeriod
    ? await sections.run("compare_orders", FINANCE_SECTION_REQUIRES.orders, ordersStatement(frame.tables), mapOrders, compareValues)
    : null;
  const products = await sections.run("products", FINANCE_SECTION_REQUIRES.products, productsStatement(frame.tables), mapProducts);
  const neverCharged = await sections.run("never_charged", FINANCE_SECTION_REQUIRES.neverCharged, neverChargedStatement(frame.tables), mapNeverCharged);
  const ledger = await sections.custom("ledger", FINANCE_SECTION_REQUIRES.ledger, (runner) => readLedger(runner, frame));
  const disputes = await sections.custom("disputes", FINANCE_SECTION_REQUIRES.disputes, (runner) => readDisputes(runner, frame));
  const returnFees = await sections.run("return_fees", FINANCE_SECTION_REQUIRES.returnFees, returnFeesStatement(frame.tables), mapReturnFees);
  const wallets = await sections.run("wallets", FINANCE_SECTION_REQUIRES.wallets, walletsStatement(frame.tables), mapWallets);
  const pool = await sections.custom("pool", FINANCE_SECTION_REQUIRES.pool, (runner) => readPool(runner, frame));
  const vendors = await sections.run("vendors", FINANCE_SECTION_REQUIRES.vendors, vendorsStatement(frame.tables), mapVendors);

  const checks: Partial<Record<FinanceSqlCheckId, FinanceRawResult<FinanceRawCheckCounts>>> = {};
  const runCheck = async (check: FinanceCheckSql, values: Readonly<Record<FinanceSqlParam, unknown>>) => {
    const statement = check.build(flags);
    checks[check.id] = await sections.run(`check_${check.id}`, check.requires, { ...statement, text: checkCountsSql(statement.text) }, mapCheckCounts, values);
  };
  for (const check of FINANCE_CHECK_SQL) {
    if (check.id === LAST_CHECK_ID || (check.programOnly && !programView)) continue;
    await runCheck(check, frame.values);
  }
  // The bridge and then the all-time order scan run last, so the request
  // budget skips them first (contract §4).
  const bridge = programView ? await readBridge(sections) : null;
  await runCheck(lastCheck(), costWaitValues(frame, request.now));

  const raw: FinanceRawAggregates = {
    tables: frame.tables,
    bounds: frame.bounds,
    orders,
    compareOrders,
    products,
    neverCharged,
    ledger,
    disputes,
    returnFees,
    wallets,
    pool,
    bridge,
    vendors,
    checks: completeChecks(checks),
  };
  return { raw, vendor, statements: transaction.statementOutcomes() };
}

/** K3, the all-time order scan, runs after everything else. */
const LAST_CHECK_ID: FinanceSqlCheckId = "K3";

function lastCheck(): FinanceCheckSql {
  const check = FINANCE_CHECK_SQL.find((candidate) => candidate.id === LAST_CHECK_ID);
  if (!check) throw new DropshipError("DROPSHIP_FINANCE_INTERNAL_ERROR", "The cost-wait check is not defined.");
  return check;
}

/** K3 looks at every order accepted before now − FINANCE_COST_WAIT_ALERT_DAYS (C9). */
function costWaitValues(frame: SnapshotFrame, now: Date): Readonly<Record<FinanceSqlParam, unknown>> {
  const cutOff = new Date(now.getTime() - FINANCE_COST_WAIT_ALERT_DAYS * MS_PER_DAY);
  return { ...frame.values, startBound: OPEN_START_BOUND, endBound: cutOff.toISOString() };
}

function completeChecks(checks: Partial<Record<FinanceSqlCheckId, FinanceRawResult<FinanceRawCheckCounts>>>): FinanceRawChecks {
  for (const check of FINANCE_CHECK_SQL) {
    if (!check.programOnly && checks[check.id] === undefined) {
      throw new DropshipError("DROPSHIP_FINANCE_INTERNAL_ERROR", "A finance check was not run.", { checkId: check.id });
    }
  }
  return checks as FinanceRawChecks;
}

async function lookUpVendor(transaction: FinanceReadTransaction, frame: SnapshotFrame, vendorId: number): Promise<FinanceVendorRecord> {
  if (!frame.tables.vendors) {
    throw new DropshipError(FINANCE_TABLE_MISSING_SQL_CODE, "The vendors table is missing, so the page cannot be scoped to a vendor.");
  }
  const rows = await transaction.query<Row>(FINANCE_VENDOR_LOOKUP.text, valuesFor(FINANCE_VENDOR_LOOKUP, frame.values));
  const row = rows[0];
  if (!row) throw new DropshipError(FINANCE_VENDOR_NOT_FOUND_CODE, "That vendor does not exist.", { vendorId });
  return { vendorId: id(row, "vendor_id"), businessName: textOrNull(row, "business_name"), contactName: textOrNull(row, "contact_name") };
}

async function readLedger(runner: FinanceQueryRunner, frame: SnapshotFrame): Promise<FinanceRawLedger> {
  const groups = mapLedgerGroups(await runner.query<Row>(FINANCE_LEDGER_GROUPS.text, valuesFor(FINANCE_LEDGER_GROUPS, frame.values)));
  const failure = await runner.query<Row>(FINANCE_FIRST_FAILURE_CODE.text, valuesFor(FINANCE_FIRST_FAILURE_CODE, frame.values));
  return { groups, firstFailureCode: failure[0] ? textOrNull(failure[0], "failure_code") : null };
}

async function readDisputes(runner: FinanceQueryRunner, frame: SnapshotFrame): Promise<FinanceRawDisputes> {
  const won = mapWonDisputes(await runner.query<Row>(FINANCE_WON_DISPUTES.text, valuesFor(FINANCE_WON_DISPUTES, frame.values)));
  const notWon = (await runner.query<Row>(FINANCE_NOT_WON_BACK.text, valuesFor(FINANCE_NOT_WON_BACK, frame.values)))[0] ?? {};
  return { won, notWonBack: { disputes: big(notWon, "disputes"), disputedCents: big(notWon, "disputed_cents") } };
}

async function readPool(runner: FinanceQueryRunner, frame: SnapshotFrame): Promise<FinanceRawPool> {
  const statement = poolStatement(frame.tables);
  const row = (await runner.query<Row>(statement.text, valuesFor(statement, frame.values)))[0] ?? {};
  // Claims are optional: without the table the builder marks the claims line unavailable.
  const claims = frame.tables.claims
    ? (await runner.query<Row>(FINANCE_POOL_CLAIMS.text, valuesFor(FINANCE_POOL_CLAIMS, frame.values))).map((claim) => ({
        status: text(claim, "status"),
        claims: big(claim, "claims"),
        asked: big(claim, "asked"),
      }))
    : [];
  return {
    setAsideBeforeStart: big(row, "set_aside_before_start"),
    setAsideP: big(row, "set_aside_p"),
    toppedUpBeforeStart: big(row, "topped_up_before_start"),
    toppedUpP: big(row, "topped_up_p"),
    recordedLedgerAtEnd: big(row, "recorded_ledger_at_end"),
    claims,
  };
}

function readBridge(sections: SectionRunner): Promise<FinanceRawResult<FinanceRawBridge>> {
  return sections.run("overview_bridge", FINANCE_SECTION_REQUIRES.bridge, FINANCE_OVERVIEW_BRIDGE, (rows) => {
    const row = rows[0] ?? {};
    return { omsRow: big(row, "oms_row"), notAccepted: big(row, "not_accepted"), notAcceptedOrders: big(row, "not_accepted_orders") };
  });
}

/** Runs a section after checking the tables it needs (a missing one is that section's error, contract §2.0). */
class SectionRunner {
  constructor(private readonly transaction: FinanceReadTransaction, private readonly frame: SnapshotFrame) {}

  run<T>(
    name: string,
    requires: readonly FinanceTableKey[],
    statement: FinanceSqlStatement,
    map: (rows: readonly Row[]) => T,
    values: Readonly<Record<FinanceSqlParam, unknown>> = this.frame.values,
  ): Promise<FinanceRawResult<T>> {
    return this.custom(name, requires, async (runner) => map(await runner.query<Row>(statement.text, valuesFor(statement, values))));
  }

  custom<T>(name: string, requires: readonly FinanceTableKey[], work: (runner: FinanceQueryRunner) => Promise<T>): Promise<FinanceRawResult<T>> {
    if (requires.some((table) => !this.frame.tables[table])) {
      return Promise.resolve(this.transaction.notRun<T>(name, FINANCE_TABLE_MISSING_SQL_CODE));
    }
    return this.transaction.section(name, work);
  }
}
