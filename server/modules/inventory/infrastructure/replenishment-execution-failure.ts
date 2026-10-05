export interface ReplenishmentExecutionFailure {
  retryable: boolean;
  code: string;
}

// No immediate replay: these failures retain durable task intent for the worker.
// Connection failures can have an uncertain commit outcome; the task row and
// journal receipt, not the error, determine whether physical work already ran.
const RETRYABLE_EXECUTION_CODES = new Set([
  "40001",
  "40P01",
  "55P03",
  "57014",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "57P01",
  "57P02",
  "57P03",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
]);

/** Drizzle may wrap pg errors in cause; a coded business error stays decisive. */
export function classifyReplenishmentExecutionFailure(
  error: unknown,
): ReplenishmentExecutionFailure {
  const visited = new Set<object>();
  let current = error;
  while (
    current !== null &&
    typeof current === "object" &&
    !visited.has(current)
  ) {
    visited.add(current);
    if ("code" in current && typeof current.code === "string") {
      return {
        retryable: RETRYABLE_EXECUTION_CODES.has(current.code),
        code: current.code,
      };
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return { retryable: false, code: "REPLENISHMENT_EXECUTION_UNCLASSIFIED" };
}
