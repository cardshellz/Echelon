import { z } from "zod";
import { channelProviderReadDiagnosticSchema, providerReadDiagnosticFromError } from "@shared/channel-provider-read";
import { EBAY_POLICY_KINDS, ebayPolicySourceSchema } from "@shared/ebay-business-policies";
import { channelOperationFailureSchema } from "@shared/channel-operation-failure";
import { channelOperationFailure } from "../../infrastructure/channel-operation-failure";
import { channelListingValidationSchema, channelListingValidationFromError } from "@shared/channel-listing-validation";
import { channelProviderWriteDiagnosticSchema, providerWriteDiagnosticFromError } from "@shared/channel-provider-write";

const diagnosticCode = z.string().regex(/^[A-Z0-9_]{1,100}$/);
const diagnosticId = z.number().int().positive().max(2147483647);
export const ebayListingFailureDiagnosticSchema = z.object({
  code: diagnosticCode,
  context: z.object({
    failure: channelOperationFailureSchema.optional(),
    providerRead: channelProviderReadDiagnosticSchema.optional(),
    providerWrite: channelProviderWriteDiagnosticSchema.optional(),
    validation: channelListingValidationSchema.optional(),
    productId: diagnosticId.optional(),
    productVariantId: diagnosticId.optional(),
    publicationTargetId: diagnosticId.optional(),
    blockerCodes: z.array(diagnosticCode).max(50).optional(),
    policySource: ebayPolicySourceSchema.optional(),
    policyKind: z.enum(EBAY_POLICY_KINDS).optional(),
    policyId: z.string().max(100).nullable().optional(),
  }).strict(),
}).strict();
export type EbayListingFailureDiagnostic = z.infer<typeof ebayListingFailureDiagnosticSchema>;

/** Keep exact scope evidence without copying provider bodies, SQL, credentials or
 * arbitrary error context into durable events or application logs. */
export function ebayListingFailureDiagnostic(error: unknown): EbayListingFailureDiagnostic {
  const raw = error instanceof Error ? error as Error & { code?: unknown; context?: unknown } : undefined;
  const code = diagnosticCode.safeParse(raw?.code);
  const source = raw?.context && typeof raw.context === "object" ? raw.context as Record<string, unknown> : {};
  const providerRead = providerReadDiagnosticFromError(error);
  const providerWrite = providerWriteDiagnosticFromError(error);
  const validation = channelListingValidationFromError(error);
  const failure = !providerRead && (!code.success || raw?.cause instanceof Error) ? channelOperationFailure(error) : undefined;
  const context: EbayListingFailureDiagnostic["context"] = { ...(providerRead ? { providerRead } : {}) };
  if (providerWrite) context.providerWrite = providerWrite;
  if (validation) context.validation = validation;
  if (failure) context.failure = failure;
  for (const key of ["productId", "productVariantId", "publicationTargetId"] as const) {
    const parsed = diagnosticId.safeParse(source[key]);
    if (parsed.success) context[key] = parsed.data;
  }
  const blockers = z.array(diagnosticCode).max(50).safeParse(source.blockerCodes);
  if (blockers.success) context.blockerCodes = blockers.data;
  const policySource = ebayPolicySourceSchema.safeParse(source.policySource);
  if (policySource.success) {
    context.policySource = policySource.data;
    const kind = z.enum(EBAY_POLICY_KINDS).safeParse(source.policyKind);
    if (kind.success) context.policyKind = kind.data;
    const id = z.string().max(100).nullable().safeParse(source.policyId);
    if (id.success) context.policyId = id.data;
  }
  return { code: validation ? "CHANNEL_LISTING_VALIDATION_FAILED" : code.success ? code.data : failure?.category === "pool_acquisition_timeout"
    ? "DATABASE_POOL_ACQUIRE_TIMEOUT" : "EBAY_LISTING_SYNC_FAILED", context };
}
