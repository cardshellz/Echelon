import { z } from "zod";

export const purchaseApprovalInputSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  expectedTotalCents: z.number().int().nonnegative().safe(),
  expectedLinesFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  notes: z.string().trim().max(4_000).optional(),
}).strict();
export type PurchaseApprovalInput = z.infer<typeof purchaseApprovalInputSchema>;

export const purchaseApprovalResultSchema = z.object({
  id: z.number().int().positive(),
  status: z.literal("approved"),
  approvedBy: z.string().min(1),
  totalCents: z.number().int().nonnegative().safe(),
  updatedAt: z.string().datetime({ offset: true }),
  reviewedUpdatedAt: z.string().datetime({ offset: true }),
  reviewedLinesFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  approvalCommand: z.object({
    name: z.literal("procurement.purchase_order.approve"),
    idempotencyKey: z.string().min(8).max(200),
  }).strict(),
}).passthrough();
export type PurchaseApprovalResult = z.infer<typeof purchaseApprovalResultSchema>;
