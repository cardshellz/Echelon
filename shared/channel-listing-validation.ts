import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
export const channelListingValidationSchema = z.object({
  field: z.enum(["package_weight", "package_dimensions", "package_type", "price", "policies", "variant_identity", "listing_identity"]),
  reason: z.enum(["required", "invalid"]),
  productId: id,
  variantId: id.optional(),
  variantSku: z.string().trim().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
}).strict();
export type ChannelListingValidation = z.infer<typeof channelListingValidationSchema>;

export const channelListingWarningSchema = z.object({
  code: z.literal("CHANNEL_PACKAGE_DIMENSIONS_MISSING"),
  field: z.literal("package_dimensions"),
  productId: id,
  variantId: id,
  variantSku: z.string().trim().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/),
}).strict();
export type ChannelListingWarning = z.infer<typeof channelListingWarningSchema>;

/** A source correction is not a transport failure. Only typed, safe fields
 * cross into durable diagnostics; no raw input, SQL or provider body is saved. */
export class ChannelListingValidationError extends Error {
  readonly code = "CHANNEL_LISTING_VALIDATION_FAILED";
  readonly context: { validation: ChannelListingValidation };
  constructor(input: ChannelListingValidation) {
    const validation = channelListingValidationSchema.parse(input);
    const label = {
      package_weight: "Package weight", package_dimensions: "Package length, width and height", package_type: "Shipping package type",
      price: "Listing price", policies: "Business policy selection",
      variant_identity: "Catalog variant identity", listing_identity: "Channel listing identity",
    }[validation.field];
    const target = validation.variantSku ? ` for ${validation.variantSku}` : validation.variantId ? ` for variant ${validation.variantId}` : "";
    super(`${label} is ${validation.reason === "required" ? "required" : "invalid"}${target}. Correct the saved source before syncing.`);
    this.name = "ChannelListingValidationError";
    this.context = { validation };
  }
}

export function channelListingValidationFromError(error: unknown): ChannelListingValidation | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && seen.size < 8 && !seen.has(current)) {
    seen.add(current);
    const context = (current as Error & { context?: { validation?: unknown } }).context;
    const parsed = channelListingValidationSchema.safeParse(context?.validation);
    if (parsed.success) return parsed.data;
    current = current.cause;
  }
  return undefined;
}
