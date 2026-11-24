/**
 * Structured, classified errors raised by the Channel Allocation engine.
 *
 * Classification contract (CLAUDE.md §6):
 *   - transient: the computation could not be completed this run (for example the
 *     sales-velocity query failed). Callers must NOT publish anything for the product
 *     on this run; the next scheduled or event-driven sync retries naturally.
 *   - permanent: the inputs or configuration are invalid (for example a rule with a
 *     share above 100% or a variant with zero units per variant). Retrying without a
 *     configuration change cannot succeed; the product needs a human.
 *
 * The engine never returns a partially computed allocation. A thrown error is the
 * only signal, so consumers cannot accidentally publish a quantity that was derived
 * from a failed read.
 */

export type AllocationEngineErrorClassification = "transient" | "permanent";

export const ALLOCATION_ERROR_CODES = {
  /** The sales-velocity query threw; a days-of-cover floor could not be evaluated. */
  VELOCITY_UNAVAILABLE: "ALLOCATION_VELOCITY_UNAVAILABLE",
  /** The sales-velocity query returned a value that is not a finite non-negative number. */
  VELOCITY_INVALID: "ALLOCATION_VELOCITY_INVALID",
  /** A days-of-cover rule was evaluated without a velocity reading (engine invariant). */
  VELOCITY_REQUIRED: "ALLOCATION_VELOCITY_REQUIRED",
  /** An ATP or variant input is not a safe non-negative integer, or units per variant < 1. */
  INPUT_INVALID: "ALLOCATION_INPUT_INVALID",
  /** A channel allocation rule carries an out-of-range value or unknown mode. */
  RULE_INVALID: "ALLOCATION_RULE_INVALID",
  /** A computed quantity left the safe integer range. */
  RESULT_UNSAFE: "ALLOCATION_RESULT_UNSAFE",
} as const;

export type AllocationErrorCode = (typeof ALLOCATION_ERROR_CODES)[keyof typeof ALLOCATION_ERROR_CODES];

export class AllocationEngineError extends Error {
  readonly code: AllocationErrorCode;
  readonly classification: AllocationEngineErrorClassification;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: AllocationErrorCode,
    classification: AllocationEngineErrorClassification,
    message: string,
    context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AllocationEngineError";
    this.code = code;
    this.classification = classification;
    this.context = context;
    Object.setPrototypeOf(this, AllocationEngineError.prototype);
  }

  toJSON() {
    return {
      error: true,
      code: this.code,
      classification: this.classification,
      message: this.message,
      context: this.context,
    };
  }
}

export function isAllocationEngineError(error: unknown): error is AllocationEngineError {
  return error instanceof AllocationEngineError;
}

/**
 * Describe any failure raised while allocating or publishing a product so that
 * every caller logs the same `error_code` / `error_class` fields. Unknown errors
 * are reported as such rather than guessed at.
 */
export function describeAllocationFailure(error: unknown): {
  error_code: string;
  error_class: AllocationEngineErrorClassification | "unknown";
  message: string;
} {
  if (isAllocationEngineError(error)) {
    return { error_code: error.code, error_class: error.classification, message: error.message };
  }
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return {
      error_code: (error as { code: string }).code,
      error_class: "unknown",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    error_code: "ALLOCATION_SYNC_UNCLASSIFIED",
    error_class: "unknown",
    message: error instanceof Error ? error.message : String(error),
  };
}
