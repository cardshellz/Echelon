const MAX_SERIALIZATION_ATTEMPTS = 3;

type MasterDataOperation = "create_transformation_draft" | "edit_transformation_draft"
  | "refresh_transformation_draft";

/**
 * The callback must include the entire database transaction, including commit.
 * Drizzle rolls back and releases its connection before rejecting. Retrying here
 * acquires a fresh snapshot and rechecks owner state and idempotency receipts.
 * Never put provider calls or nontransactional side effects in this callback.
 *
 * Only a known serialization abort is retried: a connection error may leave
 * commit outcome uncertain, and constraint/business failures must not be hidden.
 */
export async function retrySerializableMasterDataTransaction<T>(
  operation: MasterDataOperation,
  executeTransaction: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await executeTransaction();
    } catch (error) {
      if (attempt >= MAX_SERIALIZATION_ATTEMPTS || !isSerializationFailure(error)) throw error;
      console.warn(JSON.stringify({
        code: "INVENTORY_AVAILABILITY_SERIALIZATION_RETRY",
        operation,
        failedAttempt: attempt,
        maxAttempts: MAX_SERIALIZATION_ATTEMPTS,
      }));
    }
  }
}

function isSerializationFailure(error: unknown): boolean {
  const visited = new Set<object>();
  let current = error;
  while (current !== null && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    if ("code" in current && current.code !== undefined) return current.code === "40001";
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
