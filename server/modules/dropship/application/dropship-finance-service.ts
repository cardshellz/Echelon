/**
 * Program finance (contract §1.1, §5): the use case behind
 * GET /api/dropship/admin/finance/summary.
 *
 * It validates the query strictly, resolves the period with the injected
 * clock, reads one database snapshot through the repository port, and hands
 * the raw aggregates to the pure builder. It decides nothing about money:
 * every figure comes from domain/program-finance-statement.ts.
 *
 * Logging (platform JSON logger, contract §5): one INFO line per summary
 * served, one line per section that could not be read (WARN when a retry may
 * fix it, ERROR when a human must look), one ERROR per figure withheld as out
 * of range. No money value is ever logged; these lines are an access audit,
 * not a state change. A request that fails is logged by the route; the
 * failure it gets from here carries the request's correlation fields for
 * that line (never for the response).
 */

import {
  FINANCE_TIME_ZONE,
  financeSummaryQuerySchema,
  type FinanceSectionKey,
  type FinanceSummary,
} from "../../../../shared/dropship/program-finance";
import { DropshipError } from "../domain/errors";
import { resolveFinancePeriod, type FinanceLocalWindow } from "../domain/program-finance-period";
import type { FinanceErrorCode, FinanceRawAggregates } from "../domain/program-finance-raw";
import { financeVendorName } from "../domain/program-finance-rules";
import { buildFinanceSummary, financeSummaryDiagnostics } from "../domain/program-finance-statement";

export const FINANCE_INVALID_INPUT_CODE = "DROPSHIP_FINANCE_INVALID_INPUT";
export const FINANCE_VENDOR_NOT_FOUND_CODE = "DROPSHIP_FINANCE_VENDOR_NOT_FOUND";
export const FINANCE_INTERNAL_ERROR_CODE = "DROPSHIP_FINANCE_INTERNAL_ERROR";
const BUDGET_EXCEEDED_CODE = "DROPSHIP_FINANCE_BUDGET_EXCEEDED";
const AMOUNT_OUT_OF_RANGE_CODE = "DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE";

// ── error classes (contract §5) ─────────────────────────────────────────

export type FinanceErrorClassification = "transient" | "permanent" | "fatal";

/**
 * The single code → class map (contract §5). DropshipError has no
 * classification field, so this table is where a finance code gets one:
 * the route answers with it (beside its own HTTP status per code), the
 * client retries only `transient`, and every log line names it. A code not
 * listed is an internal error, so `fatal`.
 */
const FINANCE_ERROR_CLASSIFICATIONS: Readonly<Record<string, FinanceErrorClassification>> = Object.freeze({
  DROPSHIP_FINANCE_INVALID_INPUT: "permanent",
  DROPSHIP_FINANCE_INVALID_PERIOD: "permanent",
  DROPSHIP_FINANCE_INVALID_CURSOR: "permanent",
  DROPSHIP_FINANCE_ORDER_NOT_FOUND: "permanent",
  DROPSHIP_FINANCE_VENDOR_NOT_FOUND: "permanent",
  DROPSHIP_FINANCE_EXPORT_TOO_LARGE: "permanent",
  DROPSHIP_FINANCE_ORDER_TOO_LARGE: "permanent",
  DROPSHIP_FINANCE_BUSY: "transient",
  DROPSHIP_FINANCE_QUERY_TIMEOUT: "transient",
  DROPSHIP_FINANCE_DB_UNAVAILABLE: "transient",
  DROPSHIP_FINANCE_TABLE_MISSING: "transient",
  DROPSHIP_FINANCE_BUDGET_EXCEEDED: "transient",
  DROPSHIP_FINANCE_SCHEMA_MISMATCH: "fatal",
  // Bad stored data: retrying reads the same rows, so it is not transient.
  DROPSHIP_FINANCE_DATA_INVALID: "permanent",
  DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE: "fatal",
  DROPSHIP_FINANCE_CONTRACT_VIOLATION: "fatal",
  [FINANCE_INTERNAL_ERROR_CODE]: "fatal",
});

/** Every code the class map knows (the error-map test walks them). */
export const FINANCE_CLASSIFIED_CODES: readonly string[] = Object.freeze(Object.keys(FINANCE_ERROR_CLASSIFICATIONS));

/** The class of a finance error code; a code the map does not know (or none) is fatal. */
export function financeErrorClassification(code: string | undefined): FinanceErrorClassification {
  return (code !== undefined ? FINANCE_ERROR_CLASSIFICATIONS[code] : undefined) ?? "fatal";
}

/**
 * The correlation fields of contract §5 that the route copies onto a failed
 * request's log line, under the `correlation` key of the error's context.
 * They are never part of the response.
 */
export interface FinanceLogCorrelation {
  readonly vendor_id: number | null;
  readonly period_preset: string;
  readonly period_from: string | null;
  readonly period_to: string | null;
  readonly compare?: boolean;
  readonly generated_at: string;
  readonly duration_ms: number;
}

// ── ports ───────────────────────────────────────────────────────────────

export interface DropshipFinanceClock {
  now(): Date;
}

/** The platform JSON logger's shape (server/platform/observability/logger.ts). */
export interface DropshipFinanceLogger {
  info(action: string, data: Record<string, unknown>): void;
  warn(action: string, data: Record<string, unknown>): void;
  error(action: string, data: Record<string, unknown>): void;
}

export interface DropshipFinanceActor {
  /** The signed-in staff user's id, for the access audit line. */
  readonly actorId: string | null;
}

export interface FinanceSummaryReadRequest {
  readonly period: FinanceLocalWindow;
  /** Null when Compare is off or the period is all time. */
  readonly comparePeriod: FinanceLocalWindow | null;
  /** The injected clock's reading: every "now" in SQL is this value (contract §1.1). */
  readonly now: Date;
  readonly vendorId: number | null;
}

/** How one statement of the snapshot ended (no values, no SQL text). */
export interface FinanceStatementOutcome {
  readonly name: string;
  readonly status: "ok" | "error" | "skipped";
  readonly errorCode?: FinanceErrorCode;
  /** The Postgres SQLSTATE when the database refused the statement. */
  readonly sqlState?: string;
  /** For any other failure: the refused column or the error's class (never a value). */
  readonly detail?: string;
  readonly durationMs: number;
}

export interface FinanceVendorRecord {
  readonly vendorId: number;
  readonly businessName: string | null;
  readonly contactName: string | null;
}

export interface FinanceSummaryRead {
  readonly raw: FinanceRawAggregates;
  /** The vendor in view as stored; null for the whole program. */
  readonly vendor: FinanceVendorRecord | null;
  readonly statements: readonly FinanceStatementOutcome[];
}

/**
 * The read model (infrastructure/dropship-finance.repository.ts). Throws
 * DROPSHIP_FINANCE_VENDOR_NOT_FOUND for an unknown vendor, and the request
 * codes of contract §5 (BUSY, DB_UNAVAILABLE, QUERY_TIMEOUT, …) when the
 * snapshot itself cannot be taken.
 */
export interface DropshipFinanceRepository {
  readSummary(request: FinanceSummaryReadRequest): Promise<FinanceSummaryRead>;
}

export interface DropshipFinanceServiceDependencies {
  readonly repository: DropshipFinanceRepository;
  readonly clock: DropshipFinanceClock;
  readonly logger: DropshipFinanceLogger;
}

export const systemDropshipFinanceClock: DropshipFinanceClock = {
  now: () => new Date(),
};

// ── the service ─────────────────────────────────────────────────────────

export class DropshipFinanceService {
  constructor(private readonly deps: DropshipFinanceServiceDependencies) {}

  /**
   * The Program finance summary for a query string (contract §1.3 GET
   * /summary). `input` is the raw query object; anything it holds besides
   * period, from, to, compare and vendorId is refused.
   */
  async getSummary(input: unknown, actor: DropshipFinanceActor): Promise<FinanceSummary> {
    const parsed = financeSummaryQuerySchema.safeParse(input);
    if (!parsed.success) {
      throw new DropshipError(FINANCE_INVALID_INPUT_CODE, "The finance page's period or vendor is not valid.", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    const query = parsed.data;
    const now = this.deps.clock.now();
    const vendorId = query.vendorId ?? null;
    // Until the period resolves, the line names the days asked for (schema-checked YYYY-MM-DD, or none).
    let correlation: Omit<FinanceLogCorrelation, "duration_ms"> = {
      vendor_id: vendorId,
      period_preset: query.period,
      period_from: query.from ?? null,
      period_to: query.to ?? null,
      generated_at: now.toISOString(),
    };
    try {
      const resolved = resolveFinancePeriod(query.period, query.from ?? null, query.to ?? null, now, FINANCE_TIME_ZONE);
      // All time has nothing earlier to compare with; asking for it is not an error.
      const comparePeriod = query.compare === "off" || query.period === "all" ? null : resolved.compare;
      correlation = {
        ...correlation,
        period_from: resolved.current.fromDate,
        period_to: resolved.current.toDate,
        compare: comparePeriod !== null,
      };

      const read = await this.deps.repository.readSummary({ period: resolved.current, comparePeriod, now, vendorId });
      const vendor = read.vendor
        ? financeVendorName(read.vendor.vendorId, read.vendor.businessName, read.vendor.contactName)
        : null;
      const summary = buildFinanceSummary(read.raw, { generatedAt: now, period: resolved.current, comparePeriod, vendor });

      this.logServed(summary, read.statements, { actor_id: actor.actorId, ...correlation, duration_ms: this.elapsedMs(now) });
      return summary;
    } catch (error) {
      throw withLogCorrelation(error, { ...correlation, duration_ms: this.elapsedMs(now) });
    }
  }

  private elapsedMs(since: Date): number {
    return Math.max(0, this.deps.clock.now().getTime() - since.getTime());
  }

  private logServed(summary: FinanceSummary, statements: readonly FinanceStatementOutcome[], correlation: Record<string, unknown>): void {
    const diagnostics = financeSummaryDiagnostics(summary);
    const skipped = statements.filter((statement) => statement.status === "skipped").map((statement) => statement.name);
    if (skipped.length > 0) {
      this.deps.logger.warn("dropship.finance.budget_exceeded", {
        ...correlation,
        outcome: "skipped",
        error_code: BUDGET_EXCEEDED_CODE,
        error_class: financeErrorClassification(BUDGET_EXCEEDED_CODE),
        skipped_sections: skipped,
      });
    }
    for (const statement of statements) {
      if (statement.status !== "error") continue;
      // WARN when a retry may fix it (transient); ERROR when a human must look (permanent or fatal).
      const errorClass = financeErrorClassification(statement.errorCode);
      const entry = {
        ...correlation,
        outcome: "section_failed",
        section: statement.name,
        error_code: statement.errorCode,
        error_class: errorClass,
        ...(statement.sqlState ? { sql_state: statement.sqlState } : {}),
        ...(statement.detail ? { detail: statement.detail } : {}),
        statement_ms: statement.durationMs,
      };
      if (errorClass === "transient") this.deps.logger.warn("dropship.finance.section_failed", entry);
      else this.deps.logger.error("dropship.finance.section_failed", entry);
    }
    for (const lineKey of diagnostics.outOfRange) {
      this.deps.logger.error("dropship.finance.amount_out_of_range", {
        ...correlation,
        outcome: "withheld",
        error_code: AMOUNT_OUT_OF_RANGE_CODE,
        error_class: financeErrorClassification(AMOUNT_OUT_OF_RANGE_CODE),
        line_key: lineKey,
      });
    }
    this.deps.logger.info("dropship.finance.summary_served", {
      ...correlation,
      outcome: "served",
      section_statuses: diagnostics.sectionStatuses as Readonly<Record<FinanceSectionKey | "answer", string>>,
      checks_needing_look: diagnostics.checksNeedingLook,
      checks_not_run: diagnostics.checksNotRun,
      statements: statements.length,
    });
  }
}

/**
 * The failure, unchanged in code, message and context, plus the request's
 * correlation fields under `correlation` for the route's log line. A failure
 * that is not a DropshipError is a bug: it becomes INTERNAL_ERROR and keeps
 * the original as `cause`, so the log line can still say what it was.
 */
function withLogCorrelation(error: unknown, correlation: FinanceLogCorrelation): DropshipError {
  if (error instanceof DropshipError) {
    return new DropshipError(error.code, error.message, { ...error.context, correlation });
  }
  return new DropshipError(FINANCE_INTERNAL_ERROR_CODE, "The finance figures could not be read.", { correlation, cause: error });
}
