import { z } from "zod";

export const channelProviderWriteDiagnosticSchema = z.object({
  provider: z.string().regex(/^[a-z][a-z0-9_-]{0,50}$/),
  kind: z.enum(["validation", "authentication", "access_denied", "throttled"]),
  // Bulk APIs can report rejected members in a successful HTTP envelope.
  httpStatus: z.number().int().min(100).max(599),
  errorCodes: z.array(z.string().regex(/^[A-Z0-9_]{1,100}$/)).max(25),
}).strict();
export type ChannelProviderWriteDiagnostic = z.infer<typeof channelProviderWriteDiagnosticSchema>;

/** The adapter supplies protocol evidence; this shared owner decides whether
 * the unchanged input can recover automatically. Ambiguous writes never enter
 * this contract: the existing receipt-reconciliation owner must settle them. */
export function providerWriteShouldRetry(failure: ChannelProviderWriteDiagnostic): boolean {
  return channelProviderWriteDiagnosticSchema.parse(failure).kind === "throttled";
}

export function providerWriteDiagnosticFromError(error: unknown): ChannelProviderWriteDiagnostic | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && seen.size < 8 && !seen.has(current)) {
    seen.add(current);
    const parsed = channelProviderWriteDiagnosticSchema.safeParse(
      (current as Error & { providerWrite?: unknown }).providerWrite);
    if (parsed.success) return parsed.data;
    current = current.cause;
  }
  return undefined;
}
