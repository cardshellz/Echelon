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
  // A deferred Dropship listing still needs sealed warehouse/dial definitions
  // even though this cutover has no provider-write row for that listing.
  quantityReadConfiguration: z.object({
    productVariantIds: z.array(id).min(1).refine(ids => new Set(ids).size === ids.length, "Duplicate quantity-read SKU"),
    sourceBindingId: id,
    sourceBindingVersion: id,
    sourceBindingDefinitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    policySelections: z.array(z.object({
      scopeKey: z.string().trim().min(1).max(200), policyId: id, version: id,
      definitionHash: z.string().regex(/^[a-f0-9]{64}$/), authority: z.enum(["draft", "active"]),
    }).strict()),
  }).strict().optional(),
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
}).strict().superRefine((selection, context) => {
  if (selection.quantityReadConfiguration && (selection.targetIdentity?.destinationKind !== "dropship_store_connection"
    || selection.targetIdentity.publicationAuthority !== "echelon" || selection.membership.mode !== "explicit"
    || selection.quantityReadConfiguration.productVariantIds.some(id => selection.membership.mode === "explicit"
      && [...selection.membership.includedVariantIds, ...(selection.membership.excludedVariantIds ?? [])].includes(id)))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["quantityReadConfiguration"],
      message: "Only deferred Echelon Dropship SKUs without a membership decision may retain read-only quantity configuration" });
  }
});
