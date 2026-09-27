import { z } from "zod";

const id = z.number().int().positive().safe();
export const returnPolicyArchivePolicySchema = z.object({
  id,
  name: z.string().min(1).max(160),
  version: id,
  scopeKind: z.enum([
    "global",
    "business_context",
    "channel_context",
    "vendor_context",
    "vendor_channel_context",
    "store",
  ]),
  scopeKey: z.string().min(1).max(255),
  businessContext: z.enum(["retail", "dropship"]).nullable(),
  channelId: id.nullable(),
  vendorId: id.nullable(),
  storeConnectionId: id.nullable(),
  status: z.enum(["active", "retired"]),
  returnWindowDays: z.number().int().min(0).max(3650),
});
export const MAX_RETURN_POLICY_ARCHIVE_CONTEXTS = 10_000;
export const returnPolicyArchivePreviewSchema = z
  .object({
    policy: returnPolicyArchivePolicySchema,
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    effects: z
      .array(
        z
          .object({
            contextLabel: z.string().min(1).max(4_000),
            before: returnPolicyArchivePolicySchema,
            after: returnPolicyArchivePolicySchema.nullable(),
          })
          .strict(),
      )
      .max(MAX_RETURN_POLICY_ARCHIVE_CONTEXTS),
    unaffectedMoreSpecificPolicies: z
      .array(returnPolicyArchivePolicySchema)
      .max(2_000),
    historicalReferences: z
      .object({
        returnCases: z.number().int().nonnegative().safe(),
        portalIntakes: z.number().int().nonnegative().safe(),
      })
      .strict(),
  })
  .strict();
export const returnPolicyArchiveInputSchema = z
  .object({
    expectedVersion: id,
    previewRevision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const returnPolicyArchiveResultSchema = z
  .object({ policy: returnPolicyArchivePolicySchema, replayed: z.boolean() })
  .strict();
export type ReturnPolicyArchivePolicy = z.infer<
  typeof returnPolicyArchivePolicySchema
>;
export type ReturnPolicyArchivePreview = z.infer<
  typeof returnPolicyArchivePreviewSchema
>;
export type ReturnPolicyArchiveInput = z.infer<
  typeof returnPolicyArchiveInputSchema
>;
