import { z } from "zod";

const MAX_POSTGRES_INTEGER = 2_147_483_647;
const MAX_POSTGRES_BIGINT = BigInt("9223372036854775807");

const revision = z.string().regex(/^[1-9][0-9]*$/).max(19)
  .refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= MAX_POSTGRES_BIGINT);
export const enableInventoryPublicationTargetRequestSchema = z.object({
  publicationTargetId: z.number().int().positive().max(MAX_POSTGRES_INTEGER),
  expectedRevision: revision,
  idempotencyKey: z.string().trim().min(1).max(120),
}).strict();
export const inventoryPublicationTargetEnableResultSchema = z.object({
  publicationTargetId: z.number().int().positive().max(MAX_POSTGRES_INTEGER),
  revision,
  state: z.literal("live"),
  publicationRows: z.number().int().nonnegative(),
  initialDefinitionsApplied: z.number().int().min(0).max(2),
  alreadyApplied: z.boolean(),
  runtimeAuthorityChanged: z.literal(false),
  providerWriteAttempted: z.literal(false),
}).strict();
export type EnableInventoryPublicationTargetRequest = z.infer<typeof enableInventoryPublicationTargetRequestSchema>;
export type InventoryPublicationTargetEnableResult = z.infer<typeof inventoryPublicationTargetEnableResultSchema>;
