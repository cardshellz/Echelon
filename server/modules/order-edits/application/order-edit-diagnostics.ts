import { createHash } from "node:crypto";
import { ZodError } from "zod";

const MAX_DIAGNOSTIC_TEXT = 1000;
const MAX_STACK_FRAMES = 8;
const MAX_CAUSE_DEPTH = 3;

function safeText(value: string): string {
  return value
    .replace(/(?:https?|postgres(?:ql)?):\/\/[^\s)]+/gi, "[redacted-url]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:shpat_|shpca_|shppa_|shpss_)[\w-]+/g, "[redacted-token]")
    .replace(
      /(["']?(?:password|authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[redacted]",
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, MAX_DIAGNOSTIC_TEXT);
}

export interface OrderEditDiagnosticError {
  name: string;
  code?: string;
  message: string;
  stack: string[];
  validation?: Array<{ path: string; code: string }>;
  cause?: OrderEditDiagnosticError;
}

/** Never serialize the error object: driver fields can contain SQL, parameters or credentials. */
export function orderEditDiagnosticError(
  error: unknown,
  depth = 0,
): OrderEditDiagnosticError {
  if (!(error instanceof Error))
    return {
      name: "NonErrorThrown",
      message: "A non-Error value was thrown",
      stack: [],
    };
  const code =
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Za-z0-9_:-]{1,80}$/.test(error.code)
      ? error.code
      : undefined;
  // PostgreSQL messages/detail may contain row values. SQLSTATE and frames locate the failure without those values.
  const databaseError = code !== undefined && /^[0-9A-Z]{5}$/.test(code);
  return {
    name: safeText(error.name),
    ...(code ? { code } : {}),
    message: databaseError
      ? "Database operation failed; inspect SQLSTATE and stack"
      : error instanceof ZodError
        ? "Response validation failed"
        : safeText(error.message),
    stack: (
      error.stack
        ?.split("\n")
        .filter((line) => /^\s+at /.test(line))
        .slice(0, MAX_STACK_FRAMES) ?? []
    ).map(safeText),
    ...(error instanceof ZodError
      ? {
          validation: error.issues
            .slice(0, 20)
            .map((issue) => ({ path: issue.path.join("."), code: issue.code })),
        }
      : {}),
    ...(error.cause !== undefined && depth < MAX_CAUSE_DEPTH
      ? { cause: orderEditDiagnosticError(error.cause, depth + 1) }
      : {}),
  };
}

export interface OrderEditDiagnosticEvent {
  operationId: string;
  code: string;
  phase?: string;
  connectionId?: number;
  omsOrderId?: number;
  actorFingerprint?: string;
  occurredAt?: string;
  error?: OrderEditDiagnosticError;
}

export function orderEditActorFingerprint(actorId: string): string {
  return createHash("sha256").update(actorId).digest("hex");
}
