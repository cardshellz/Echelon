import { z } from "zod";
import { publicationMembershipBlockerSchema, publicationMembershipReceiptSchema } from "./inventory-publication-membership";

const id = z.number().int().positive().max(2_147_483_647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().trim().min(1).max(100);
export const inventoryEbayPublicationReadinessInputSchema = z.object({
  channelId: id, connectionId: id, accountId: z.string().trim().min(1).max(255),
  environment: z.enum(["production", "sandbox"]), productId: id,
  variants: z.array(z.object({ productVariantId: id, sku: identity }).strict()).min(1).max(500)
    .refine(rows => new Set(rows.map(row => row.productVariantId)).size === rows.length
      && new Set(rows.map(row => row.sku)).size === rows.length, "Each variant and provider SKU must be unique"),
}).strict();
export const inventoryEbayPublicationReadinessSchema = z.object({
  channelId: id, connectionId: id, productId: id,
  publicationTargetId: id.nullable(), targetRevision: z.string().nullable(),
  reviewHash: hash, ready: z.boolean(), currentlyReady: z.boolean(),
  variants: z.array(z.object({
    productVariantId: id, sku: identity,
    mappingAction: z.enum(["none", "promote_draft", "create"]),
    membershipAction: z.enum(["none", "include"]),
    desiredQuantity: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
  }).strict()),
  blockers: z.array(publicationMembershipBlockerSchema), effects: z.array(z.string()),
}).strict();
export const inventoryEbayPublicationReadinessApplySchema = z.object({
  source: inventoryEbayPublicationReadinessInputSchema,
  expectedReviewHash: hash, contextHash: hash, commandKey: z.string().uuid(),
}).strict();
export const inventoryEbayPublicationReadinessReceiptSchema = z.object({
  channelId: id, productId: id, commandKey: z.string().uuid(),
  reviewHash: hash, contextHash: hash, appliedAt: z.string().datetime(), appliedBy: z.string().trim().min(1).max(100),
  membership: publicationMembershipReceiptSchema, alreadyApplied: z.boolean(),
}).strict();
export type InventoryEbayPublicationReadinessInput = z.infer<typeof inventoryEbayPublicationReadinessInputSchema>;
export type InventoryEbayPublicationReadiness = z.infer<typeof inventoryEbayPublicationReadinessSchema>;
export type InventoryEbayPublicationReadinessApply = z.infer<typeof inventoryEbayPublicationReadinessApplySchema>;
export type InventoryEbayPublicationReadinessReceipt = z.infer<typeof inventoryEbayPublicationReadinessReceiptSchema>;
