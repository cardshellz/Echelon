const MAX_CAUSE_DEPTH = 4;
const MAX_FAILURE_LENGTH = 2000;

/** Keep the cause that makes a handoff actionable after application logs expire.
 * Only error codes/messages are retained, not SQL parameters, stacks or payloads.
 */
export function describeWmsSyncFailure(error: unknown): string {
  const visited = new Set<unknown>();
  const parts: string[] = [];
  let current = error;
  while (current != null && !visited.has(current) && parts.length < MAX_CAUSE_DEPTH) {
    visited.add(current);
    const record = typeof current === "object" ? current as Record<string, unknown> : null;
    const code = typeof record?.code === "string" && /^[A-Z0-9_]{1,100}$/.test(record.code)
      ? `[${record.code}] ` : "";
    const message = current instanceof Error ? current.message
      : typeof current === "string" ? current : "Unknown WMS sync failure";
    parts.push(code + message.replace(/\bfailed query:[\s\S]*/i, "Database query failed")
      .replace(/\b(?:params|parameters):[\s\S]*/i, "parameters=[redacted]")
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted URL]")
      .replace(/\bauthorization\s*[:=]\s*(?:Bearer\s+|Basic\s+)?\S+/gi, "authorization=[redacted]")
      .replace(/\b(password|token|api[_-]?key|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "$1=[redacted]")
      .replace(/[\r\n\t]+/g, " ").slice(0, 500));
    current = record?.cause;
  }
  return parts.join("; caused by ").slice(0, MAX_FAILURE_LENGTH);
}
