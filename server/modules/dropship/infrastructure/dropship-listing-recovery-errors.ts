import { DropshipError } from "../domain/errors";

export type DropshipRecoveryErrorClassification = "transient" | "permanent";

/**
 * PostgreSQL SQLSTATE classes that repeat on every retry of the same row:
 * data exceptions (22), integrity violations (23), syntax or undefined objects
 * (42). Lock, serialization, resource and connection failures (40, 53, 55,
 * 57, 08) clear on their own and are retried on the next pass.
 */
const PERMANENT_SQLSTATE_CLASSES: ReadonlySet<string> = new Set(["22", "23", "42"]);

/**
 * How a recovery step failed for one row. A permanent failure is marked for
 * review and never retried; a transient one is retried on the next pass.
 */
export function classifyRecoveryError(error: unknown): DropshipRecoveryErrorClassification {
  if (error instanceof DropshipError) {
    const classification = error.context?.classification;
    if (classification === "transient") return "transient";
    if (classification === "permanent" || classification === "fatal") return "permanent";
    return error.context?.retryable === false ? "permanent" : "transient";
  }
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
    return PERMANENT_SQLSTATE_CLASSES.has(code.slice(0, 2)) ? "permanent" : "transient";
  }
  return "transient";
}

export function recoveryErrorCode(error: unknown): string {
  if (error instanceof DropshipError) return error.code;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && code.length > 0 ? code : "DROPSHIP_RECOVERY_STEP_FAILED";
}

export function recoveryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
