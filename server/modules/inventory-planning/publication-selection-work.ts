/** A busy selection was not saved. Callers should return a retryable conflict,
 * not report success or expose PostgreSQL diagnostics to the operator. */
export function publicationSelectionBusyIssue(error: unknown): { code: string; message: string; retryable: true } | null {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === "55P03" && candidate.message === "PUBLICATION_SELECTION_BUSY") return {
      code: "PUBLICATION_SELECTION_BUSY",
      message: "A stock update is finishing. Your selection was not saved; retry it in a moment.",
      retryable: true,
    };
    current = candidate.cause;
  }
  return null;
}
