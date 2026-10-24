import { z } from "zod";

const token = z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/);
/** Safe diagnostics only. Never retain a response body, URL query, headers or credentials. */
export const channelProviderReadDiagnosticSchema = z.object({
  provider: token,
  resource: token,
  method: z.literal("GET"),
  kind: z.enum(["unavailable", "invalid_response", "refused"]),
  httpStatus: z.number().int().min(100).max(599).optional(),
  requestId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,200}$/).optional(),
  issues: z.array(z.object({
    path: z.string().regex(/^[a-zA-Z0-9_.\[\]-]{0,240}$/),
    code: token,
  }).strict()).max(25).optional(),
  issuesTruncated: z.boolean().optional(),
}).strict();
export type ChannelProviderReadDiagnostic = z.infer<typeof channelProviderReadDiagnosticSchema>;

/** Restore a validated read diagnostic when a transport-neutral DTO crosses
 * back into an exception path. Error translations must retain this as cause. */
export class ChannelProviderReadError extends Error {
  readonly context: { providerRead: ChannelProviderReadDiagnostic };
  constructor(read: ChannelProviderReadDiagnostic) {
    super("Channel provider read did not complete.");
    this.name = "ChannelProviderReadError";
    this.context = { providerRead: channelProviderReadDiagnosticSchema.parse(read) };
  }
}

// Repeated schema failures may require an adapter fix. Stop after a bounded
// number of reads while retaining the failed job and all diagnostic evidence.
export const INVALID_PROVIDER_READ_RETRY_LIMIT = 5;
/** A failed GET never authorizes a write or clears an unresolved write receipt. */
export function providerReadShouldRetry(read: ChannelProviderReadDiagnostic, attempts: number): boolean {
  if (!Number.isSafeInteger(attempts) || attempts < 0) throw new Error("Invalid provider read attempt count.");
  return read.kind === "unavailable"
    || (read.kind === "invalid_response" && attempts < INVALID_PROVIDER_READ_RETRY_LIMIT);
}

export function providerReadDiagnosticFromError(error: unknown): ChannelProviderReadDiagnostic | undefined {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error && !seen.has(current); depth++) {
    seen.add(current);
    const context = (current as Error & { context?: unknown }).context;
    const parsed = channelProviderReadDiagnosticSchema.safeParse(
      context && typeof context === "object" && "providerRead" in context ? context.providerRead : undefined,
    );
    if (parsed.success) return parsed.data;
    current = current.cause;
  }
  return undefined;
}

export function providerReadDetails(read: ChannelProviderReadDiagnostic): Array<{label: string; value: string}> {
  const parsed = channelProviderReadDiagnosticSchema.parse(read);
  return [
    { label: "Provider read", value: parsed.provider + " / " + parsed.resource + " (GET)" },
    ...(parsed.httpStatus ? [{ label: "HTTP status", value: String(parsed.httpStatus) }] : []),
    ...(parsed.requestId ? [{ label: "Provider request", value: parsed.requestId }] : []),
    ...(parsed.issues ?? []).slice(0, 20).map(issue => ({ label: "Rejected field", value: (issue.path || "(response)") + ": " + issue.code })),
    ...(parsed.issuesTruncated ? [{ label: "Validation", value: "Additional validation issues were truncated." }] : []),
  ];
}
