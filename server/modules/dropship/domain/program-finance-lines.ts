/**
 * The building blocks of the Program finance summary (contract §1.2, §2):
 * turning BigInt sums into contract numbers, statement lines with their
 * unit, status, operator and link, working steps, and a view over the
 * ledger groups of Q4. Pure; used by program-finance-statement.ts.
 *
 * A number the contract can't carry exactly is never rounded or zeroed:
 * the line becomes "unavailable" with DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE.
 */

import {
  FINANCE_SECTION_LINE_KEYS,
  type FinanceDatedBy,
  type FinanceLine,
  type FinanceLineKey,
  type FinanceOperator,
  type FinancePrior,
  type FinanceSectionKey,
  type FinanceSectionLineKey,
  type FinanceWorkingStep,
} from "../../../../shared/dropship/program-finance";
import {
  FINANCE_LINE_DEFINITIONS,
  type FinanceReasonKey,
} from "../../../../shared/dropship/program-finance-definitions";
import { toSafeNumber } from "../../../../shared/dropship/program-finance-money";
import type { FinanceCashLine, FinanceRawLedger, FinanceRawLedgerGroup, FinanceRawResult } from "./program-finance-raw";
import type { FinanceShare } from "./program-finance-rules";

export const FINANCE_AMOUNT_OUT_OF_RANGE_CODE = "DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE";
export const FINANCE_TABLE_MISSING_CODE = "DROPSHIP_FINANCE_TABLE_MISSING";
export const FINANCE_DATA_INVALID_CODE = "DROPSHIP_FINANCE_DATA_INVALID";
export const FINANCE_CONTRACT_VIOLATION_CODE = "DROPSHIP_FINANCE_CONTRACT_VIOLATION";
export const FINANCE_INTERNAL_ERROR_CODE = "DROPSHIP_FINANCE_INTERNAL_ERROR";

const ZERO = BigInt(0);
/** contract providerCode: the failure code is shown only when it is this plain. */
const PROVIDER_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The wallet-balance entry types (contract AVAILABLE_TYPES, recon 1). */
const AVAILABLE_TYPES: ReadonlySet<string> = new Set([
  "funding", "order_debit", "advance_fee", "funding_reversal", "funding_reinstated",
  "return_credit", "insurance_pool_credit", "return_fee", "refund_credit", "manual_adjustment",
]);
const REWARDS_TYPES: ReadonlySet<string> = new Set([
  "rewards_earned", "rewards_spent", "rewards_expired", "rewards_reversed", "rewards_reinstated",
]);
/** Entry types nothing should write; the walk shows them only when they moved (check N3). */
export const UNEXPECTED_TYPES: ReadonlySet<string> = new Set(["refund_credit", "manual_adjustment"]);

// ── figure conversion ───────────────────────────────────────────────────

/** A raw value the contract can't carry: out of the safe range, or a negative count. */
export class FinanceFigureError extends Error {
  constructor(readonly code: string, readonly what: string) {
    super(`${code}: ${what}`);
  }
}

export function cents(value: bigint, what: string): number {
  const number = toSafeNumber(value);
  if (number === null) throw new FinanceFigureError(FINANCE_AMOUNT_OUT_OF_RANGE_CODE, what);
  return number;
}

export function count(value: bigint, what: string): number {
  if (value < ZERO) throw new FinanceFigureError(FINANCE_DATA_INVALID_CODE, what);
  return cents(value, what);
}

export function optionalId(value: number | null, what: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) throw new FinanceFigureError(FINANCE_DATA_INVALID_CODE, what);
  return value;
}

export function nullableCents(value: bigint | null): number | null {
  return value === null ? null : toSafeNumber(value);
}

export function abs(value: bigint): bigint {
  return value < ZERO ? -value : value;
}

export function max0(value: bigint): bigint {
  return value > ZERO ? value : ZERO;
}

export function sumBig(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, ZERO);
}

// ── raw outcomes ────────────────────────────────────────────────────────

/** Why a figure has no number: a failed statement, a missing table, or a program-wide figure in a vendor's view. */
export interface Unavailable {
  readonly errorCode?: string;
  readonly reasonKey?: FinanceReasonKey;
}

export type Source<T> = { readonly data: T; readonly failure: null } | { readonly data: null; readonly failure: Unavailable & { status: "error" | "skipped"; errorCode: string } };

export function sourceOf<T>(result: FinanceRawResult<T>): Source<T> {
  if (result.status === "ok") return { data: result.data, failure: null };
  return { data: null, failure: { status: result.status, errorCode: result.errorCode } };
}

export const TABLE_MISSING: Unavailable = Object.freeze({ errorCode: FINANCE_TABLE_MISSING_CODE, reasonKey: "table_missing" });
export const PROGRAM_WIDE: Unavailable = Object.freeze({ reasonKey: "program_wide" });
const INTERNAL: { status: "error"; errorCode: string } = Object.freeze({ status: "error", errorCode: FINANCE_INTERNAL_ERROR_CODE });

/** A failed source's cause; asking it of a source that did not fail is a builder bug, reported as internal. */
export function causeOf<T>(source: Source<T>): { status: "error" | "skipped"; errorCode: string } {
  return source.failure ?? INTERNAL;
}

// ── lines ───────────────────────────────────────────────────────────────

export interface LineOptions {
  readonly datedBy: FinanceDatedBy;
  readonly operator?: FinanceOperator;
  /** Hidden in Summary depth when the amount is zero (a part, a memo). */
  readonly everyLineWhenZero?: boolean;
  readonly count?: bigint;
  readonly coverage?: { readonly done: bigint; readonly total: bigint };
  readonly share?: FinanceShare;
  readonly prior?: FinancePrior | null;
  /** Makes the line "partial", with this reason. */
  readonly partialReason?: FinanceReasonKey | null;
  readonly failureCode?: string | null;
}

function lineBase(key: FinanceLineKey, operator: FinanceOperator, datedBy: FinanceDatedBy) {
  const definition = FINANCE_LINE_DEFINITIONS[key];
  return {
    key,
    operator,
    unit: definition.unit,
    datedBy,
    ...(definition.opensMetric ? { opensMetric: definition.opensMetric } : {}),
  };
}

export function unavailableLine(key: FinanceLineKey, cause: Unavailable, options: Pick<LineOptions, "datedBy" | "operator">): FinanceLine {
  return {
    ...lineBase(key, options.operator ?? "none", options.datedBy),
    amount: null,
    status: "unavailable",
    depth: "summary",
    ...(cause.errorCode ? { errorCode: cause.errorCode } : {}),
    ...(cause.reasonKey ? { reasonKey: cause.reasonKey } : {}),
  };
}

export function notRecordedLine(key: FinanceLineKey, reasonKey: FinanceReasonKey, datedBy: FinanceDatedBy): FinanceLine {
  return { ...lineBase(key, "none", datedBy), amount: null, status: "not_recorded", reasonKey, depth: "summary" };
}

/**
 * "x of y" for a line, or null when it can't be shown truthfully: more done
 * than there are (over-shipped packs, which check O6 lists) or numbers the
 * contract can't carry. The line keeps its amount either way.
 */
function coverageOf(coverage: { done: bigint; total: bigint }): { done: number; total: number } | null {
  if (coverage.done < ZERO || coverage.done > coverage.total) return null;
  const done = toSafeNumber(coverage.done);
  const total = toSafeNumber(coverage.total);
  return done === null || total === null ? null : { done, total };
}

/** A line with a number; a number the contract can't carry turns it "unavailable". */
export function recordedLine(key: FinanceLineKey, value: bigint, options: LineOptions): FinanceLine {
  try {
    const amount = cents(value, key);
    const coverage = options.coverage ? coverageOf(options.coverage) : null;
    const tenths = options.share?.tenths ?? null;
    const bps = options.share?.bps ?? null;
    return {
      ...lineBase(key, options.operator ?? "none", options.datedBy),
      amount,
      status: options.partialReason ? "partial" : "recorded",
      depth: options.everyLineWhenZero && value === ZERO ? "every_line" : "summary",
      ...(options.partialReason ? { reasonKey: options.partialReason } : {}),
      ...(options.count !== undefined ? { count: count(options.count, `${key}.count`) } : {}),
      ...(coverage ? { coverage } : {}),
      ...(options.share ? { percentTenths: tenths === null ? null : toSafeNumber(tenths), percentBps: bps === null ? null : toSafeNumber(bps) } : {}),
      ...(options.prior ? { prior: options.prior } : {}),
      ...(options.failureCode && PROVIDER_CODE_PATTERN.test(options.failureCode) ? { failureCode: options.failureCode } : {}),
    };
  } catch (error) {
    if (!(error instanceof FinanceFigureError)) throw error;
    const reasonKey: FinanceReasonKey | undefined = error.code === FINANCE_AMOUNT_OUT_OF_RANGE_CODE ? "amount_out_of_range" : undefined;
    return unavailableLine(key, { errorCode: error.code, reasonKey }, options);
  }
}

/**
 * A statement movement: `quantity` is what the line names (a cost of 3764
 * on a "minus" line). Its effect on the total picks the operator, so the
 * amount shown is never negative on a plus/minus line.
 */
export function directedLine(key: FinanceLineKey, quantity: bigint, usual: "plus" | "minus", options: LineOptions): FinanceLine {
  const effect = usual === "minus" ? -quantity : quantity;
  const operator: FinanceOperator = effect > ZERO ? "plus" : effect < ZERO ? "minus" : usual;
  return recordedLine(key, abs(effect), { ...options, operator });
}

/** One section's lines by key, emitted in the section's statement order. */
export class LineSet<S extends FinanceSectionKey> {
  private readonly lines = new Map<string, FinanceLine>();

  constructor(private readonly section: S) {}

  add(line: FinanceLine): FinanceLine {
    this.lines.set(line.key, line);
    return line;
  }

  get(key: FinanceSectionLineKey<S>): FinanceLine | undefined {
    return this.lines.get(key);
  }

  attachWorkings(key: FinanceSectionLineKey<S>, workings: FinanceWorkingStep[]): void {
    const line = this.lines.get(key);
    if (line && line.amount !== null && workings.length > 0) this.lines.set(key, { ...line, workings });
  }

  sorted(): FinanceLine[] {
    const order: readonly string[] = FINANCE_SECTION_LINE_KEYS[this.section];
    return [...this.lines.values()].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }
}

// ── working steps ───────────────────────────────────────────────────────

export type FinanceWorkingOperand = FinanceWorkingStep["operands"][number];

/** The operands a working step cites, from the page's own lines (absent lines are left out). */
export function operandsOf(lines: readonly (FinanceLine | undefined)[]): FinanceWorkingOperand[] {
  return lines.filter((line): line is FinanceLine => line !== undefined).map((line) => ({
    // Every line this module emits carries a FinanceLineKey; the schema re-checks it.
    lineKey: line.key as FinanceLineKey,
    amount: line.amount,
    unit: line.unit,
    // The first operand starts the sum; an "equals" result read as an operand is a starting value.
    operator: line.operator === "equals" ? "none" : line.operator,
  }));
}

export function stepOf(step: number, textKey: string, operands: FinanceWorkingOperand[], result: number | null): FinanceWorkingStep {
  const metric = Object.prototype.hasOwnProperty.call(FINANCE_LINE_DEFINITIONS, textKey)
    ? FINANCE_LINE_DEFINITIONS[textKey as FinanceLineKey].opensMetric
    : undefined;
  return { step, textKey, operands, result, ...(metric ? { opensMetric: metric } : {}) };
}

/** A one-step working for a result line: how its operands make it. */
export function lineWorking<S extends FinanceSectionKey>(lines: LineSet<S>, key: FinanceSectionLineKey<S>, operandKeys: readonly FinanceSectionLineKey<S>[]): void {
  const result = lines.get(key);
  if (!result || result.amount === null) return;
  const operands = operandKeys.map((operandKey) => lines.get(operandKey));
  if (operands.some((operand) => operand === undefined || operand.amount === null)) return;
  lines.attachWorkings(key, [stepOf(1, key, operandsOf(operands), result.amount)]);
}

// ── ledger view ─────────────────────────────────────────────────────────

export type LedgerAmountField = {
  [K in keyof FinanceRawLedgerGroup]: FinanceRawLedgerGroup[K] extends bigint ? K : never;
}[keyof FinanceRawLedgerGroup];

export type GroupFilter = (group: FinanceRawLedgerGroup) => boolean;

export const ofType = (type: string): GroupFilter => (group) => group.type === type;
export const deposit = (cashLine?: FinanceCashLine): GroupFilter => (group) =>
  group.type === "funding" && (cashLine === undefined || group.cashLine === cashLine);
export const cashDeposit: GroupFilter = (group) => group.type === "funding" && group.cashLine !== "manual";
export const staffCredit: GroupFilter = (group) => group.type === "funding" && group.cashLine === "manual";

export class LedgerView {
  constructor(readonly ledger: FinanceRawLedger) {}

  sum(field: LedgerAmountField, filter: GroupFilter): bigint {
    let total = ZERO;
    for (const group of this.ledger.groups) if (filter(group)) total += group[field];
    return total;
  }

  /** Σ field by vendor over the groups the filter keeps. */
  byVendor(field: LedgerAmountField, filter: GroupFilter): Map<number, bigint> {
    const totals = new Map<number, bigint>();
    for (const group of this.ledger.groups) {
      if (filter(group)) totals.set(group.vendorId, (totals.get(group.vendorId) ?? ZERO) + group[field]);
    }
    return totals;
  }
}

export const availableType: GroupFilter = (group) => AVAILABLE_TYPES.has(group.type);
export const rewardsType: GroupFilter = (group) => REWARDS_TYPES.has(group.type);
