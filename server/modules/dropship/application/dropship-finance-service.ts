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
 * not a state change.
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

/**
 * Section failures a retry may fix (contract §5 "transient"): logged at WARN.
 * Every other section failure needs a human and is logged at ERROR. The
 * error-map test keeps this set in step with classifyFinanceError.
 */
export const FINANCE_TRANSIENT_SECTION_CODES: ReadonlySet<string> = new Set([
  "DROPSHIP_FINANCE_QUERY_TIMEOUT",
  "DROPSHIP_FINANCE_DB_UNAVAILABLE",
  "DROPSHIP_FINANCE_TABLE_MISSING",
  "DROPSHIP_FINANCE_BUDGET_EXCEEDED",
]);
const BUDGET_EXCEEDED_CODE = "DROPSHIP_FINANCE_BUDGET_EXCEEDED";

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
    const resolved = resolveFinancePeriod(query.period, query.from ?? null, query.to ?? null, now, FINANCE_TIME_ZONE);
    // All time has nothing earlier to compare with; asking for it is not an error.
    const comparePeriod = query.compare === "off" || query.period === "all" ? null : resolved.compare;
    const vendorId = query.vendorId ?? null;

    const read = await this.deps.repository.readSummary({ period: resolved.current, comparePeriod, now, vendorId });
    const vendor = read.vendor
      ? financeVendorName(read.vendor.vendorId, read.vendor.businessName, read.vendor.contactName)
      : null;
    const summary = buildFinanceSummary(read.raw, { generatedAt: now, period: resolved.current, comparePeriod, vendor });

    this.logServed(summary, read.statements, {
      actor_id: actor.actorId,
      vendor_id: vendorId,
      period_preset: query.period,
      period_from: resolved.current.fromDate,
      period_to: resolved.current.toDate,
      compare: comparePeriod !== null,
      generated_at: now.toISOString(),
      duration_ms: Math.max(0, this.deps.clock.now().getTime() - now.getTime()),
    });
    return summary;
  }

  private logServed(summary: FinanceSummary, statements: readonly FinanceStatementOutcome[], correlation: Record<string, unknown>): void {
    const diagnostics = financeSummaryDiagnostics(summary);
    const skipped = statements.filter((statement) => statement.status === "skipped").map((statement) => statement.name);
    if (skipped.length > 0) {
      this.deps.logger.warn("dropship.finance.budget_exceeded", {
        ...correlation,
        outcome: "skipped",
        error_code: BUDGET_EXCEEDED_CODE,
        error_class: "transient",
        skipped_sections: skipped,
      });
    }
    for (const statement of statements) {
      if (statement.status !== "error") continue;
      const transient = statement.errorCode !== undefined && FINANCE_TRANSIENT_SECTION_CODES.has(statement.errorCode);
      const entry = {
        ...correlation,
        outcome: "section_failed",
        section: statement.name,
        error_code: statement.errorCode,
        error_class: transient ? "transient" : "fatal",
        ...(statement.sqlState ? { sql_state: statement.sqlState } : {}),
        ...(statement.detail ? { detail: statement.detail } : {}),
        statement_ms: statement.durationMs,
      };
      if (transient) this.deps.logger.warn("dropship.finance.section_failed", entry);
      else this.deps.logger.error("dropship.finance.section_failed", entry);
    }
    for (const lineKey of diagnostics.outOfRange) {
      this.deps.logger.error("dropship.finance.amount_out_of_range", {
        ...correlation,
        outcome: "withheld",
        error_code: "DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE",
        error_class: "fatal",
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
