import { z } from "zod";

const diagnosticCode = z.string().regex(/^[A-Z0-9_]{1,100}$/);
const diagnosticId = z.number().int().positive().max(2147483647);
export const ebayListingFailureDiagnosticSchema = z.object({
  code: diagnosticCode,
  context: z.object({
    productId: diagnosticId.optional(),
    productVariantId: diagnosticId.optional(),
    publicationTargetId: diagnosticId.optional(),
    blockerCodes: z.array(diagnosticCode).max(50).optional(),
  }).strict(),
}).strict();
export type EbayListingFailureDiagnostic = z.infer<typeof ebayListingFailureDiagnosticSchema>;

/** Keep exact scope evidence without copying provider bodies, SQL, credentials or
 * arbitrary error context into durable events or application logs. */
export function ebayListingFailureDiagnostic(error: unknown): EbayListingFailureDiagnostic {
  const raw = error instanceof Error ? error as Error & { code?: unknown; context?: unknown } : undefined;
  const code = diagnosticCode.safeParse(raw?.code);
  const source = raw?.context && typeof raw.context === "object" ? raw.context as Record<string, unknown> : {};
  const context: EbayListingFailureDiagnostic["context"] = {};
  for (const key of ["productId", "productVariantId", "publicationTargetId"] as const) {
    const parsed = diagnosticId.safeParse(source[key]);
    if (parsed.success) context[key] = parsed.data;
  }
  const blockers = z.array(diagnosticCode).max(50).safeParse(source.blockerCodes);
  if (blockers.success) context.blockerCodes = blockers.data;
  return { code: code.success ? code.data : "EBAY_LISTING_SYNC_FAILED", context };
}
