import type { Express, NextFunction, Request, Response } from "express";
import {
  financeErrorEnvelopeSchema,
  financeSummarySchema,
  type FinanceErrorEnvelope,
} from "../../../../../shared/dropship/program-finance";
import { logger as platformLogger } from "../../../../platform/observability/logger";
import { requirePermission } from "../../../../routes/middleware";
import type { DropshipFinanceLogger, DropshipFinanceService } from "../../application/dropship-finance-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipFinanceServiceFromEnv } from "../../infrastructure/dropship-finance.factory";

/**
 * Admin read surface for the Dropship "Program finance" page (contract §1.1,
 * §1.3). Part 1 serves the summary only. Every response is `no-store`: the
 * page shows live money and must never be served from a cache.
 */
export const FINANCE_SUMMARY_PATH = "/api/dropship/admin/finance/summary";

export type FinanceErrorClassification = "transient" | "permanent" | "fatal";

export interface FinanceErrorClass {
  readonly status: number;
  readonly classification: FinanceErrorClassification;
}

const FINANCE_INTERNAL_ERROR_CODE = "DROPSHIP_FINANCE_INTERNAL_ERROR";
const FINANCE_CONTRACT_VIOLATION_CODE = "DROPSHIP_FINANCE_CONTRACT_VIOLATION";

/**
 * The single code → HTTP status and class map (contract §5). DropshipError
 * has no classification field, so this table is where a finance code gets
 * one; the client retries only `transient`.
 */
const FINANCE_ERROR_CLASSES: Readonly<Record<string, FinanceErrorClass>> = Object.freeze({
  DROPSHIP_FINANCE_INVALID_INPUT: { status: 400, classification: "permanent" },
  DROPSHIP_FINANCE_INVALID_PERIOD: { status: 400, classification: "permanent" },
  DROPSHIP_FINANCE_INVALID_CURSOR: { status: 400, classification: "permanent" },
  DROPSHIP_FINANCE_ORDER_NOT_FOUND: { status: 404, classification: "permanent" },
  DROPSHIP_FINANCE_VENDOR_NOT_FOUND: { status: 404, classification: "permanent" },
  DROPSHIP_FINANCE_EXPORT_TOO_LARGE: { status: 400, classification: "permanent" },
  DROPSHIP_FINANCE_ORDER_TOO_LARGE: { status: 422, classification: "permanent" },
  DROPSHIP_FINANCE_BUSY: { status: 503, classification: "transient" },
  DROPSHIP_FINANCE_QUERY_TIMEOUT: { status: 503, classification: "transient" },
  DROPSHIP_FINANCE_DB_UNAVAILABLE: { status: 503, classification: "transient" },
  DROPSHIP_FINANCE_TABLE_MISSING: { status: 503, classification: "transient" },
  DROPSHIP_FINANCE_BUDGET_EXCEEDED: { status: 503, classification: "transient" },
  DROPSHIP_FINANCE_SCHEMA_MISMATCH: { status: 500, classification: "fatal" },
  // Bad stored data: retrying reads the same rows, so it is not transient.
  DROPSHIP_FINANCE_DATA_INVALID: { status: 500, classification: "permanent" },
  DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE: { status: 500, classification: "fatal" },
  [FINANCE_CONTRACT_VIOLATION_CODE]: { status: 500, classification: "fatal" },
  [FINANCE_INTERNAL_ERROR_CODE]: { status: 500, classification: "fatal" },
});

/** Every code the map knows (the error-map test walks them). */
export const FINANCE_ERROR_CODES: readonly string[] = Object.freeze(Object.keys(FINANCE_ERROR_CLASSES));

/** HTTP status and class of a finance error code; anything unknown is an internal (fatal) error. */
export function classifyFinanceError(code: string): FinanceErrorClass {
  return FINANCE_ERROR_CLASSES[code] ?? FINANCE_ERROR_CLASSES[FINANCE_INTERNAL_ERROR_CODE];
}

/** Context keys a refused request may send back so the page can word the refusal. */
const PERMANENT_CONTEXT_KEYS = ["reason", "issues", "vendorId"] as const;

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

function logFinanceFailure(logger: DropshipFinanceLogger, error: unknown, code: string, classification: FinanceErrorClassification, actorId: string | null): void {
  const originalCode = error instanceof DropshipError ? error.code : null;
  const context = error instanceof DropshipError ? error.context : undefined;
  const entry = {
    outcome: "refused",
    endpoint: FINANCE_SUMMARY_PATH,
    actor_id: actorId,
    error_code: code,
    error_class: classification,
    ...(context?.reason !== undefined ? { reason: context.reason } : {}),
    ...(code === FINANCE_CONTRACT_VIOLATION_CODE ? { issues: issuePathsOf(context) } : {}),
    // An error the map does not know is a bug: keep what it was for the person who looks.
    ...(originalCode !== code ? { original_code: originalCode, error_message: error instanceof Error ? error.message : String(error) } : {}),
  };
  if (classification === "permanent") logger.info("dropship.finance.request_refused", entry);
  else if (classification === "transient") logger.warn("dropship.finance.request_failed", entry);
  else logger.error("dropship.finance.request_failed", entry);
}

/**
 * The error envelope of contract §5. A refused request (permanent) carries
 * the context the page words it with; a transient or fatal one carries only
 * its class, never database detail.
 */
function sendFinanceError(res: Response, error: unknown, logger: DropshipFinanceLogger, actorId: string | null): Response {
  const known = error instanceof DropshipError && FINANCE_ERROR_CLASSES[error.code] !== undefined;
  const code = known ? (error as DropshipError).code : FINANCE_INTERNAL_ERROR_CODE;
  const { status, classification } = classifyFinanceError(code);
  logFinanceFailure(logger, error, code, classification, actorId);
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
