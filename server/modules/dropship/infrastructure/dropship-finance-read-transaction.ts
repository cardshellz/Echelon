/**
 * The one database snapshot behind a Program finance request (contract §1.1,
 * §4, §5): a pinned client, `BEGIN ISOLATION LEVEL REPEATABLE READ READ
 * ONLY`, an 8s statement timeout, UTC session time, and one SAVEPOINT per
 * section so a section that fails rolls back alone while the rest of the page
 * still renders.
 *
 * Follows inventory-channel-publication-status.repository.ts (pinned client,
 * REPEATABLE READ READ ONLY, rollback, release(true) when the rollback itself
 * fails). Never issues an advisory lock and never writes: a write attempt
 * would be refused by the READ ONLY transaction (SQLSTATE 25006), which maps
 * to DROPSHIP_FINANCE_INTERNAL_ERROR because it can only be a bug.
 *
 * Statements run one after another on the pinned client; there is no
 * parallel query (one pool shared with webhooks, contract C13).
 */

import type { Pool, PoolClient } from "pg";
import type { FinanceStatementOutcome } from "../application/dropship-finance-service";
import { DropshipError } from "../domain/errors";
import type { FinanceErrorCode, FinanceRawResult } from "../domain/program-finance-raw";

/** `SET LOCAL statement_timeout` per statement (contract §4 FINANCE_STATEMENT_TIMEOUT_MS). */
export const FINANCE_STATEMENT_TIMEOUT_MS = 8_000;
/**
 * The whole request's time budget. Checked before each section: once it is
 * spent, every later section is skipped. 20s plus one 8s statement stays under
 * Heroku's 30s router limit (contract §1.1).
 */
export const FINANCE_REQUEST_BUDGET_MS = 20_000;

export const FINANCE_BUDGET_EXCEEDED_CODE = "DROPSHIP_FINANCE_BUDGET_EXCEEDED";
export const FINANCE_QUERY_TIMEOUT_CODE = "DROPSHIP_FINANCE_QUERY_TIMEOUT";
export const FINANCE_DB_UNAVAILABLE_CODE = "DROPSHIP_FINANCE_DB_UNAVAILABLE";
export const FINANCE_TABLE_MISSING_SQL_CODE = "DROPSHIP_FINANCE_TABLE_MISSING";
export const FINANCE_SCHEMA_MISMATCH_CODE = "DROPSHIP_FINANCE_SCHEMA_MISMATCH";
export const FINANCE_DATA_INVALID_SQL_CODE = "DROPSHIP_FINANCE_DATA_INVALID";
export const FINANCE_AMOUNT_OUT_OF_RANGE_SQL_CODE = "DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE";
export const FINANCE_INTERNAL_ERROR_SQL_CODE = "DROPSHIP_FINANCE_INTERNAL_ERROR";

const BEGIN_SQL = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
const STATEMENT_TIMEOUT_SQL = `SET LOCAL statement_timeout = '${FINANCE_STATEMENT_TIMEOUT_MS / 1_000}s'`;
// UTC makes interval arithmetic and any text form of an instant deterministic.
const TIME_ZONE_SQL = "SET LOCAL TIME ZONE 'UTC'";
/** Savepoint names are fin_<n>, n a counter: never text from a request. */
const SAVEPOINT_PREFIX = "fin_";

/** The budget clock (injected so tests can jump it; the factory passes the system clock). */
export interface FinanceBudgetClock {
  now(): Date;
}

/** What a section's work may run: plain parameterized reads on the pinned client. */
export interface FinanceQueryRunner {
  query<R>(text: string, values: readonly unknown[]): Promise<R[]>;
}

/**
 * A value read from a row that the page cannot use (a sum that is not an
 * integer, an id that is not one). Thrown by the repository's row mappers
 * inside a section, so only that section fails.
 */
export class FinanceRowError extends Error {
  constructor(readonly code: FinanceErrorCode, readonly column: string) {
    super(`${code}: ${column}`);
    this.name = "FinanceRowError";
  }
}

// ── SQLSTATE → code (contract §5) ───────────────────────────────────────

const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH",
]);
/** 57P01 admin shutdown, 57P02 crash shutdown, 57P03 cannot connect now, 53300 too many connections, 40001 serialization. */
const UNAVAILABLE_SQLSTATES: ReadonlySet<string> = new Set(["57P01", "57P02", "57P03", "53300", "40001"]);
/** 22P02 invalid text representation, 22008 datetime field overflow: bad stored data despite the guards. */
const DATA_INVALID_SQLSTATES: ReadonlySet<string> = new Set(["22P02", "22008"]);
/** node-pg's own message when the pool cannot hand out a client in time. */
const POOL_CONNECT_TIMEOUT_MESSAGE = "timeout exceeded when trying to connect";

/**
 * What a person needs to find a failure that is not the database's: the
 * column a mapper refused, or the error's class. Never a message, which can
 * carry stored values.
 */
function detailOf(error: unknown): string | undefined {
  if (error instanceof FinanceRowError) return `column:${error.column}`;
  if (sqlStateOf(error)) return undefined;
  return error instanceof Error ? error.name : typeof error;
}

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/**
 * The finance error code for a failure from the database or the driver.
 * 22003 (numeric value out of range) maps to AMOUNT_OUT_OF_RANGE: every text
 * cast is guarded to at most 18 digits, so a 22003 can only be a bigint sum
 * that overflowed (contract C14).
 */
export function financeCodeForDatabaseError(error: unknown): FinanceErrorCode {
  if (error instanceof FinanceRowError) return error.code;
  const sqlState = sqlStateOf(error);
  if (sqlState) {
    if (sqlState === "57014") return FINANCE_QUERY_TIMEOUT_CODE;
    if (sqlState === "42P01") return FINANCE_TABLE_MISSING_SQL_CODE;
    if (sqlState === "42703") return FINANCE_SCHEMA_MISMATCH_CODE;
    if (sqlState === "22003") return FINANCE_AMOUNT_OUT_OF_RANGE_SQL_CODE;
    if (DATA_INVALID_SQLSTATES.has(sqlState)) return FINANCE_DATA_INVALID_SQL_CODE;
    if (sqlState.startsWith("08") || UNAVAILABLE_SQLSTATES.has(sqlState)) return FINANCE_DB_UNAVAILABLE_CODE;
    return FINANCE_INTERNAL_ERROR_SQL_CODE;
  }
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) return FINANCE_DB_UNAVAILABLE_CODE;
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.includes(POOL_CONNECT_TIMEOUT_MESSAGE)) return FINANCE_DB_UNAVAILABLE_CODE;
    if (typeof message === "string" && /Connection terminated/i.test(message)) return FINANCE_DB_UNAVAILABLE_CODE;
  }
  return FINANCE_INTERNAL_ERROR_SQL_CODE;
}

const REQUEST_FAILURE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  [FINANCE_QUERY_TIMEOUT_CODE]: "The finance figures took too long to read.",
  [FINANCE_DB_UNAVAILABLE_CODE]: "The database is not available right now.",
  [FINANCE_TABLE_MISSING_SQL_CODE]: "A table the finance page needs is missing.",
  [FINANCE_SCHEMA_MISMATCH_CODE]: "A column the finance page reads is missing.",
  [FINANCE_DATA_INVALID_SQL_CODE]: "Stored finance data could not be read.",
  [FINANCE_AMOUNT_OUT_OF_RANGE_SQL_CODE]: "A finance total is too large to show.",
});

/** A failure outside any section (connect, BEGIN, Q0, COMMIT): the whole request fails. */
export function financeRequestError(error: unknown, stage: string): DropshipError {
  if (error instanceof DropshipError) return error;
  const code = financeCodeForDatabaseError(error);
  const sqlState = sqlStateOf(error);
  return new DropshipError(code, REQUEST_FAILURE_MESSAGES[code] ?? "The finance figures could not be read.", {
    stage,
    ...(sqlState ? { sqlState } : {}),
  });
}

// ── the transaction ─────────────────────────────────────────────────────

export class FinanceReadTransaction implements FinanceQueryRunner {
  private savepoints = 0;
  private readonly outcomes: FinanceStatementOutcome[] = [];

  constructor(
    private readonly client: Pick<PoolClient, "query">,
    private readonly clock: FinanceBudgetClock,
    private readonly startedAtMs: number,
    private readonly budgetMs: number,
  ) {}

  /** A statement outside any savepoint (Q0, the vendor lookup): its failure fails the request. */
  async query<R>(text: string, values: readonly unknown[]): Promise<R[]> {
    const result = await this.client.query(text, values as unknown[]);
    return result.rows as R[];
  }

  /** Every section's outcome so far, in run order. */
  statementOutcomes(): readonly FinanceStatementOutcome[] {
    return [...this.outcomes];
  }

  /** Whether the request budget is spent (the next section would be skipped). */
  budgetSpent(): boolean {
    return this.clock.now().getTime() - this.startedAtMs > this.budgetMs;
  }

  /** Records a section that was not run because a table it needs is missing. */
  notRun<T>(name: string, errorCode: FinanceErrorCode): FinanceRawResult<T> {
    this.outcomes.push({ name, status: "error", errorCode, durationMs: 0 });
    return { status: "error", errorCode };
  }

  /**
   * Runs one section in its own savepoint. A statement or mapping failure
   * rolls back to the savepoint and becomes that section's error; the
   * request goes on. If even the rollback to the savepoint fails, the
   * transaction is in an unknown state and the whole request fails.
   */
  async section<T>(name: string, work: (runner: FinanceQueryRunner) => Promise<T>): Promise<FinanceRawResult<T>> {
    if (this.budgetSpent()) {
      this.outcomes.push({ name, status: "skipped", errorCode: FINANCE_BUDGET_EXCEEDED_CODE, durationMs: 0 });
      return { status: "skipped", errorCode: FINANCE_BUDGET_EXCEEDED_CODE };
    }
    this.savepoints += 1;
    const savepoint = `${SAVEPOINT_PREFIX}${this.savepoints}`;
    const started = this.clock.now().getTime();
    await this.client.query(`SAVEPOINT ${savepoint}`);
    try {
      const data = await work(this);
      await this.client.query(`RELEASE SAVEPOINT ${savepoint}`);
      this.outcomes.push({ name, status: "ok", durationMs: this.clock.now().getTime() - started });
      return { status: "ok", data };
    } catch (error) {
      const errorCode = financeCodeForDatabaseError(error);
      const sqlState = sqlStateOf(error);
      const detail = detailOf(error);
      try {
        await this.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Finance section ${name} failed and its savepoint could not be rolled back.`);
      }
      this.outcomes.push({
        name,
        status: "error",
        errorCode,
        ...(sqlState ? { sqlState } : {}),
        ...(detail ? { detail } : {}),
        durationMs: this.clock.now().getTime() - started,
      });
      return { status: "error", errorCode };
    }
  }
}

export interface FinanceReadTransactionOptions {
  readonly clock: FinanceBudgetClock;
  /** Defaults to FINANCE_REQUEST_BUDGET_MS. */
  readonly budgetMs?: number;
}

/**
 * Runs `work` inside one REPEATABLE READ READ ONLY transaction on a pinned
 * client. Commits on success. On any failure it rolls back; if the rollback
 * fails the client is destroyed (release(true)) rather than returned to the
 * pool in an unknown state. Failures outside a section are re-thrown as a
 * DropshipError with the finance code (contract §5).
 */
export async function withFinanceReadTransaction<T>(
  pool: Pick<Pool, "connect">,
  options: FinanceReadTransactionOptions,
  work: (transaction: FinanceReadTransaction) => Promise<T>,
): Promise<T> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw financeRequestError(error, "connect");
  }
  let discardConnection = false;
  try {
    await client.query(BEGIN_SQL);
    await client.query(STATEMENT_TIMEOUT_SQL);
    await client.query(TIME_ZONE_SQL);
    const transaction = new FinanceReadTransaction(
      client,
      options.clock,
      options.clock.now().getTime(),
      options.budgetMs ?? FINANCE_REQUEST_BUDGET_MS,
    );
    const result = await work(transaction);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original error is the one reported below; a client whose rollback
      // failed cannot go back to the pool in an unknown transaction state.
      discardConnection = true;
    }
    // A savepoint that could not be rolled back is reported by why the
    // rollback failed (usually a lost connection), not by the section's error.
    throw financeRequestError(error instanceof AggregateError ? error.errors[error.errors.length - 1] : error, "transaction");
  } finally {
    client.release(discardConnection);
  }
}
