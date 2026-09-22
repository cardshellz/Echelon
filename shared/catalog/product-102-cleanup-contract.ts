import { z } from "zod";

// One reviewed identity cleanup, not a reusable product-merge API.
export const PRODUCT_102_CLEANUP_KEY =
  "catalog:product102:into5:history-preserving:v1";
export const PRODUCT_102_COUNT_IDS = [
  3062, 3140, 3277, 3354, 3718, 3796, 3901, 3949, 4063, 4112,
] as const;
export const PRODUCT_102_UNRELATED_ORDER_IDS = [
  302040, 302869, 310633, 320232,
] as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const eventId = z.string().regex(/^[1-9][0-9]*$/);
export const product102CleanupCommandSchema = z
  .object({
    expectedHash: hash,
    actorId: z.string().trim().min(1).max(100),
    approval: z.string().trim().min(10).max(1000),
  })
  .strict();
export type Product102CleanupCommand = z.infer<
  typeof product102CleanupCommandSchema
>;
export const product102CleanupResultSchema = z
  .object({
    commandKey: z.literal(PRODUCT_102_CLEANUP_KEY),
    sourceProductId: z.literal(102),
    targetProductId: z.literal(5),
    removedSupplierMappingId: z.literal(25),
    retainedSupplierMappingId: z.literal(125),
    removedMembershipId: z.literal(71),
    correctedPoLineIds: z.tuple([z.literal(39), z.literal(221)]),
    correctedCountIds: z.array(z.number().int()),
    auditEventId: eventId,
    poEventIds: z.tuple([eventId, eventId]),
    occurredAt: z.string().datetime(),
    alreadyApplied: z.boolean(),
  })
  .strict()
  .refine(
    (result) =>
      JSON.stringify(result.correctedCountIds) ===
      JSON.stringify(PRODUCT_102_COUNT_IDS),
    "Unexpected count scope",
  );
export type Product102CleanupResult = z.infer<
  typeof product102CleanupResultSchema
>;
export class Product102CleanupError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "Product102CleanupError";
  }
}
export function cleanupRequire(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new Product102CleanupError(code, message);
}

export const product102CleanupAuditInputSchema = z
  .object({
    command: product102CleanupCommandSchema,
    requestHash: hash,
    occurredAt: z.string().datetime(),
    // PostgreSQL JSONB text must never round-trip financial numbers through JS.
    before: z.string().min(2),
    after: z.string().min(2),
  })
  .strict();
