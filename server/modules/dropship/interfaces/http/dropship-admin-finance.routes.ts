import type { Express, NextFunction, Request, Response } from "express";
import {
  financeErrorEnvelopeSchema,
  financeSummarySchema,
  type FinanceErrorEnvelope,
} from "../../../../../shared/dropship/program-finance";
import { logger as platformLogger } from "../../../../platform/observability/logger";
import { requirePermission } from "../../../../routes/middleware";
import {
  FINANCE_CLASSIFIED_CODES,
  FINANCE_INTERNAL_ERROR_CODE,
  financeErrorClassification,
  type DropshipFinanceLogger,
  type DropshipFinanceService,
  type FinanceErrorClassification,
} from "../../application/dropship-finance-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipFinanceServiceFromEnv } from "../../infrastructure/dropship-finance.factory";

/**
 * Admin read surface for the Dropship "Program finance" page (contract §1.1,
 * §1.3). Part 1 serves the summary only. Every response is `no-store`: the
 * page shows live money and must never be served from a cache.
 */
export const FINANCE_SUMMARY_PATH = "/api/dropship/admin/finance/summary";

export interface FinanceErrorClass {
  readonly status: number;
  readonly classification: FinanceErrorClassification;
}

const FINANCE_CONTRACT_VIOLATION_CODE = "DROPSHIP_FINANCE_CONTRACT_VIOLATION";

/**
 * The HTTP status of each finance code (contract §5). The class comes from
 * the one code → class map in the application layer
 * (financeErrorClassification); the error-map test keeps both maps on the
 * same codes.
 */
const FINANCE_ERROR_STATUS: Readonly<Record<string, number>> = Object.freeze({
  DROPSHIP_FINANCE_INVALID_INPUT: 400,
  DROPSHIP_FINANCE_INVALID_PERIOD: 400,
  DROPSHIP_FINANCE_INVALID_CURSOR: 400,
  DROPSHIP_FINANCE_ORDER_NOT_FOUND: 404,
  DROPSHIP_FINANCE_VENDOR_NOT_FOUND: 404,
  DROPSHIP_FINANCE_EXPORT_TOO_LARGE: 400,
  DROPSHIP_FINANCE_ORDER_TOO_LARGE: 422,
  DROPSHIP_FINANCE_BUSY: 503,
  DROPSHIP_FINANCE_QUERY_TIMEOUT: 503,
  DROPSHIP_FINANCE_DB_UNAVAILABLE: 503,
  DROPSHIP_FINANCE_TABLE_MISSING: 503,
  DROPSHIP_FINANCE_BUDGET_EXCEEDED: 503,
  DROPSHIP_FINANCE_SCHEMA_MISMATCH: 500,
  DROPSHIP_FINANCE_DATA_INVALID: 500,
  DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE: 500,
  [FINANCE_CONTRACT_VIOLATION_CODE]: 500,
  [FINANCE_INTERNAL_ERROR_CODE]: 500,
});

/** Every code the route answers with its own status (the error-map test walks them). */
export const FINANCE_ERROR_CODES: readonly string[] = Object.freeze(Object.keys(FINANCE_ERROR_STATUS));

function isAnsweredCode(code: string): boolean {
  return FINANCE_ERROR_STATUS[code] !== undefined && FINANCE_CLASSIFIED_CODES.includes(code);
}

/** HTTP status and class of a finance error code; anything unknown is an internal (fatal) error. */
export function classifyFinanceError(code: string): FinanceErrorClass {
  const answered = isAnsweredCode(code) ? code : FINANCE_INTERNAL_ERROR_CODE;
  return { status: FINANCE_ERROR_STATUS[answered], classification: financeErrorClassification(answered) };
}

/** Context keys a refused request may send back so the page can word the refusal. */
const PERMANENT_CONTEXT_KEYS = ["reason", "issues", "vendorId"] as const;

/**
 * The correlation fields (contract §5) a failed request's log line copies
 * from the service's `correlation` context. Log only: never in a response.
 */
const LOG_CORRELATION_KEYS = ["vendor_id", "period_preset", "period_from", "period_to", "compare", "generated_at", "duration_ms"] as const;

function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.set("Cache-Control", "no-store");
  next();
}

function actorIdOf(req: Request): string | null {
  const id = req.session?.user?.id;
  return id === undefined || id === null ? null : String(id);
}

export function registerDropshipAdminFinanceRoutes(
  app: Express,
  service: Pick<DropshipFinanceService, "getSummary"> = createDropshipFinanceServiceFromEnv(),
  logger: DropshipFinanceLogger = platformLogger,
): void {
  app.get(
    FINANCE_SUMMARY_PATH,
    // Before the permission check, so 401/403 are never cached either.
    noStore,
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      const actorId = actorIdOf(req);
      try {
        // Query strings arrive as text; the service's strict schema decides.
        const summary = await service.getSummary(req.query, { actorId });
        const checked = financeSummarySchema.safeParse(summary);
        if (!checked.success) {
          // Fail closed: a summary that does not fit the contract is never sent.
          throw new DropshipError(FINANCE_CONTRACT_VIOLATION_CODE, "The finance summary did not match its contract.", {
            issues: checked.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          });
        }
        return res.json(checked.data);
      } catch (error) {
        return sendFinanceError(res, error, logger, actorId);
      }
    },
  );
}

function permanentContext(context: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!context) return {};
  return Object.fromEntries(PERMANENT_CONTEXT_KEYS.filter((key) => context[key] !== undefined).map((key) => [key, context[key]]));
}

/** Issue paths only: a contract violation is logged without the values that broke it. */
function issuePathsOf(context: Record<string, unknown> | undefined): string[] | undefined {
  const issues = context?.issues;
  if (!Array.isArray(issues)) return undefined;
  return issues.map((issue) => (typeof issue === "object" && issue !== null && typeof (issue as { path?: unknown }).path === "string"
    ? (issue as { path: string }).path
    : "?"));
}

/** The request's correlation fields for the log line; the vendor a VENDOR_NOT_FOUND names when the service gave none. */
function correlationOf(context: Record<string, unknown> | undefined): Record<string, unknown> {
  const correlation = context?.correlation;
  const fields: Record<string, unknown> = {};
  if (typeof correlation === "object" && correlation !== null) {
    for (const key of LOG_CORRELATION_KEYS) {
      const value = (correlation as Record<string, unknown>)[key];
      if (value !== undefined) fields[key] = value;
    }
  }
  if (fields.vendor_id === undefined && context?.vendorId !== undefined) fields.vendor_id = context.vendorId;
  return fields;
}

/**
 * INFO `request_refused` for a refusal the page words (permanent, 4xx);
 * WARN `request_failed` when a retry may fix it; ERROR `request_failed` when
 * a human must look (fatal, or permanent bad data answered with 500).
 */
function logFinanceFailure(
  logger: DropshipFinanceLogger,
  error: unknown,
  code: string,
  { status, classification }: FinanceErrorClass,
  actorId: string | null,
): void {
  const context = error instanceof DropshipError ? error.context : undefined;
  // The service hands on a failure that was not a DropshipError as INTERNAL_ERROR, the original as its cause.
  const original = context?.cause !== undefined ? context.cause : error;
  const originalCode = original instanceof DropshipError ? original.code : null;
  const refused = classification === "permanent" && status < 500;
  const entry = {
    ...correlationOf(context),
    outcome: refused ? "refused" : "failed",
    endpoint: FINANCE_SUMMARY_PATH,
    actor_id: actorId,
    error_code: code,
    error_class: classification,
    ...(context?.reason !== undefined ? { reason: context.reason } : {}),
    ...(code === FINANCE_CONTRACT_VIOLATION_CODE ? { issues: issuePathsOf(context) } : {}),
    // An error the map does not know is a bug: keep what it was for the person who looks.
    ...(originalCode !== code ? { original_code: originalCode, error_message: original instanceof Error ? original.message : String(original) } : {}),
  };
  if (refused) logger.info("dropship.finance.request_refused", entry);
  else if (classification === "transient") logger.warn("dropship.finance.request_failed", entry);
  else logger.error("dropship.finance.request_failed", entry);
}

/**
 * The error envelope of contract §5. A refused request (permanent) carries
 * the context the page words it with; a transient or fatal one carries only
 * its class, never database detail.
 */
function sendFinanceError(res: Response, error: unknown, logger: DropshipFinanceLogger, actorId: string | null): Response {
  const known = error instanceof DropshipError && isAnsweredCode(error.code);
  const code = known ? (error as DropshipError).code : FINANCE_INTERNAL_ERROR_CODE;
  const errorClass = classifyFinanceError(code);
  const { status, classification } = errorClass;
  logFinanceFailure(logger, error, code, errorClass, actorId);
  const envelope: FinanceErrorEnvelope = {
    error: {
      code,
      message: known ? (error as DropshipError).message : "The finance figures could not be read.",
      context: {
        classification,
        ...(classification === "permanent" && known ? permanentContext((error as DropshipError).context) : {}),
      },
    },
  };
  // The envelope is checked like the summary: an error response must fit the contract too.
  const checked = financeErrorEnvelopeSchema.safeParse(envelope);
  return res.status(status).json(checked.success ? checked.data : {
    error: { code: FINANCE_INTERNAL_ERROR_CODE, message: "The finance figures could not be read.", context: { classification: "fatal" } },
  });
}
