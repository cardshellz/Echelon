import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
/** Outbound membership only. Never use this to prune the ATP supply graph. */
export const inventoryPublicationScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("whole_product") }).strict(),
  z.object({
    mode: z.literal("explicit"),
    includedVariantIds: z.array(id).refine(ids => new Set(ids).size === ids.length,
      "Publication membership must contain unique variant identities"),
    excludedVariantIds: z.array(id).refine(ids => new Set(ids).size === ids.length,
      "Publication exclusions must contain unique variant identities").optional(),
  }).strict(),
]).superRefine((scope, context) => {
  if (scope.mode === "explicit" && scope.excludedVariantIds?.some(id => scope.includedVariantIds.includes(id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A variant cannot be both included and excluded", path: ["excludedVariantIds"] });
  }
});
export type InventoryPublicationScope = z.infer<typeof inventoryPublicationScopeSchema>;

export const inventoryPublicationTargetSelectionSchema = z.object({
  publicationTargetId: id,
  revision: z.string().regex(/^[1-9]\d*$/),
  membership: inventoryPublicationScopeSchema,
  // Historical audits did not seal an identity for destinations with no rows.
  // New runs must retain it, particularly when the target is externally owned.
  targetIdentity: z.object({
    channelId: id,
    destinationKind: z.enum(["channel_connection", "dropship_store_connection"]),
    channelConnectionId: id.nullable(),
    dropshipStoreConnectionId: id.nullable(),
    providerScopeType: z.enum(["account", "location"]),
    externalScopeId: z.string().trim().min(1).max(240),
    publicationAuthority: z.enum(["echelon", "external_provider", "manual"]),
    state: z.enum(["disabled", "preview", "live"]),
  }).strict().optional(),
}).strict();
